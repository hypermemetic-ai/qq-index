use std::ffi::OsString;
use std::fs::{self, Metadata, Permissions};
use std::io::{self, BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use qq_session_index_core::SessionIndex;
use serde_json::Value;
use thiserror::Error;

use crate::protocol::{
    MAX_FRAME_BYTES, MUTATION_BATCH_VERSION, ProtocolError, RequestEnvelope, WireOperation,
    error_envelope, health_response, into_core_search, parse_request, receipt_response,
    require_operation_version, require_protocol_version, search_response, shutdown_response,
    success_envelope,
};

static SIGNAL_SHUTDOWN: AtomicBool = AtomicBool::new(false);
const ACCEPT_POLL: Duration = Duration::from_millis(25);
const CLIENT_READ_POLL: Duration = Duration::from_millis(100);
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const INVALID_REQUEST_ID: &str = "invalid";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DatabaseMode {
    Create,
    Open,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerConfig {
    pub socket_path: PathBuf,
    pub database_path: PathBuf,
    pub database_mode: DatabaseMode,
}

#[derive(Debug, Error)]
pub enum ServerError {
    #[error("invalid daemon configuration: {0}")]
    InvalidConfig(String),
    #[error("{action} {path}: {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Index(#[from] qq_session_index_core::IndexError),
}

impl ServerError {
    fn io(action: &'static str, path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            action,
            path: path.into(),
            source,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SocketIdentity {
    device: u64,
    inode: u64,
    uid: u32,
}

struct SocketGuard {
    path: PathBuf,
    identity: SocketIdentity,
}

impl Drop for SocketGuard {
    fn drop(&mut self) {
        let Ok(metadata) = fs::symlink_metadata(&self.path) else {
            return;
        };
        if metadata.file_type().is_socket()
            && socket_identity(&metadata) == self.identity
            && metadata.uid() == effective_uid()
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum FrameRead {
    Frame(Vec<u8>),
    Eof,
    Oversized,
    Unterminated,
}

pub fn run(config: &ServerConfig) -> Result<(), ServerError> {
    validate_paths(config)?;
    SIGNAL_SHUTDOWN.store(false, Ordering::SeqCst);
    install_signal_handlers()?;

    // Bind first: an unsafe pre-existing socket target must not create or open a database.
    let (listener, _socket_guard) = bind_private_socket(&config.socket_path)?;
    let index = match config.database_mode {
        DatabaseMode::Create => SessionIndex::create(&config.database_path)?,
        DatabaseMode::Open => SessionIndex::open(&config.database_path)?,
    };

    listener.set_nonblocking(true).map_err(|error| {
        ServerError::io("setting nonblocking mode on", &config.socket_path, error)
    })?;

    while !SIGNAL_SHUTDOWN.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _address)) => match handle_client(stream, &index) {
                Ok(true) => SIGNAL_SHUTDOWN.store(true, Ordering::SeqCst),
                Ok(false) => {}
                Err(error) => {
                    let _ = writeln!(
                        io::stderr().lock(),
                        "qq-session-indexd: dropping failed client connection: {error}"
                    );
                }
            },
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(ACCEPT_POLL);
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                return Err(ServerError::io(
                    "accepting a connection on",
                    &config.socket_path,
                    error,
                ));
            }
        }
    }
    Ok(())
}

fn validate_paths(config: &ServerConfig) -> Result<(), ServerError> {
    if !config.socket_path.is_absolute() {
        return Err(ServerError::InvalidConfig(
            "--socket must be an absolute path".to_owned(),
        ));
    }
    if !config.database_path.is_absolute() {
        return Err(ServerError::InvalidConfig(
            "--database must be an absolute path".to_owned(),
        ));
    }
    if config.socket_path == config.database_path {
        return Err(ServerError::InvalidConfig(
            "socket and database paths must differ".to_owned(),
        ));
    }
    Ok(())
}

fn bind_private_socket(path: &Path) -> Result<(UnixListener, SocketGuard), ServerError> {
    let parent = path.parent().ok_or_else(|| {
        ServerError::InvalidConfig("--socket must have a parent directory".to_owned())
    })?;
    ensure_private_parent(parent)?;

    match fs::symlink_metadata(path) {
        Ok(_) => {
            return Err(ServerError::InvalidConfig(format!(
                "refusing pre-existing socket target {}",
                path.display()
            )));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(ServerError::io("inspecting", path, error)),
    }

    let listener = UnixListener::bind(path)
        .map_err(|error| ServerError::io("binding Unix socket", path, error))?;
    if let Err(error) = fs::set_permissions(path, Permissions::from_mode(0o600)) {
        let _ = fs::remove_file(path);
        return Err(ServerError::io("setting permissions on", path, error));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| ServerError::io("inspecting bound socket", path, error))?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o777 != 0o600
    {
        let _ = fs::remove_file(path);
        return Err(ServerError::InvalidConfig(
            "bound socket did not retain private ownership and mode 0600".to_owned(),
        ));
    }
    let guard = SocketGuard {
        path: path.to_path_buf(),
        identity: socket_identity(&metadata),
    };
    Ok((listener, guard))
}

fn ensure_private_parent(parent: &Path) -> Result<(), ServerError> {
    match fs::symlink_metadata(parent) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700);
            builder
                .create(parent)
                .map_err(|source| ServerError::io("creating socket parent", parent, source))?;
        }
        Err(error) => return Err(ServerError::io("inspecting socket parent", parent, error)),
    }
    let metadata = fs::symlink_metadata(parent)
        .map_err(|error| ServerError::io("inspecting socket parent", parent, error))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_dir()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(ServerError::InvalidConfig(format!(
            "socket parent {} must be an owner-only directory owned by this account",
            parent.display()
        )));
    }
    Ok(())
}

fn socket_identity(metadata: &Metadata) -> SocketIdentity {
    SocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        uid: metadata.uid(),
    }
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no preconditions and does not dereference memory.
    unsafe { libc::geteuid() }
}

extern "C" fn shutdown_signal_handler(_signal: libc::c_int) {
    SIGNAL_SHUTDOWN.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() -> Result<(), ServerError> {
    // SAFETY: the installed handler only performs a lock-free atomic store, and the
    // function pointer has the signal ABI expected by libc::signal.
    unsafe {
        if libc::signal(
            libc::SIGTERM,
            shutdown_signal_handler as *const () as libc::sighandler_t,
        ) == libc::SIG_ERR
            || libc::signal(
                libc::SIGINT,
                shutdown_signal_handler as *const () as libc::sighandler_t,
            ) == libc::SIG_ERR
        {
            return Err(ServerError::io(
                "installing signal handlers for",
                OsString::from("qq-session-indexd"),
                io::Error::last_os_error(),
            ));
        }
    }
    Ok(())
}

fn handle_client(stream: UnixStream, index: &SessionIndex) -> Result<bool, ServerError> {
    let owner_is_peer = peer_has_daemon_uid(&stream);
    stream
        .set_read_timeout(Some(CLIENT_READ_POLL))
        .map_err(|error| ServerError::io("setting client read timeout on", "socket", error))?;
    stream
        .set_write_timeout(Some(CLIENT_WRITE_TIMEOUT))
        .map_err(|error| ServerError::io("setting client write timeout on", "socket", error))?;
    let mut reader = BufReader::new(stream);

    loop {
        match read_bounded_frame(&mut reader)
            .map_err(|error| ServerError::io("reading request from", "socket", error))?
        {
            FrameRead::Eof => return Ok(false),
            FrameRead::Unterminated => return Ok(false),
            FrameRead::Oversized => {
                let error =
                    ProtocolError::InvalidRequest(format!("frame exceeds {MAX_FRAME_BYTES} bytes"));
                write_value(
                    reader.get_mut(),
                    &error_envelope(INVALID_REQUEST_ID, &error),
                )?;
            }
            FrameRead::Frame(frame) => {
                let request = match parse_request(&frame) {
                    Ok(request) => request,
                    Err(error) => {
                        write_value(
                            reader.get_mut(),
                            &error_envelope(INVALID_REQUEST_ID, &error),
                        )?;
                        continue;
                    }
                };
                let request_id = request.request_id.clone();
                match dispatch(request, index, owner_is_peer) {
                    Ok((response, should_shutdown)) => {
                        write_value(reader.get_mut(), &success_envelope(&request_id, response))?;
                        if should_shutdown {
                            return Ok(true);
                        }
                    }
                    Err(error) => {
                        write_value(reader.get_mut(), &error_envelope(&request_id, &error))?;
                    }
                }
            }
        }
        if SIGNAL_SHUTDOWN.load(Ordering::SeqCst) {
            return Ok(false);
        }
    }
}

fn dispatch(
    request: RequestEnvelope,
    index: &SessionIndex,
    owner_is_peer: bool,
) -> Result<(Value, bool), ProtocolError> {
    require_protocol_version(&request.protocol_version)?;
    check_deadline(request.deadline_unix_ms)?;

    let (response, should_shutdown) = match request.operation {
        WireOperation::Health => (health_response(&index.metadata()?), false),
        WireOperation::ApplyBatch { version, batch } => {
            require_operation_version(&version, MUTATION_BATCH_VERSION)?;
            let receipt = index.apply_batch(&batch.into_core()?)?;
            (receipt_response(&receipt), false)
        }
        WireOperation::SearchBatch {
            version,
            literals,
            per_source_depth,
            final_limit,
            filters,
            minimum_source_watermark,
        } => {
            require_operation_version(&version, qq_session_index_core::SEARCH_BATCH_VERSION_V1)?;
            let core_request = into_core_search(
                literals,
                per_source_depth,
                final_limit,
                filters,
                minimum_source_watermark,
            )?;
            let response = index.search_batch_v1(&core_request)?;
            (search_response(&response), false)
        }
        WireOperation::Shutdown => {
            if !owner_is_peer {
                return Err(ProtocolError::Forbidden);
            }
            (shutdown_response(), true)
        }
    };

    // Queue time and core execution both count. There is deliberately no claim of
    // active SQLite interruption in this serialized first slice.
    check_deadline(request.deadline_unix_ms)?;
    Ok((response, should_shutdown))
}

fn check_deadline(deadline_unix_ms: u64) -> Result<(), ProtocolError> {
    if now_unix_ms() > deadline_unix_ms {
        Err(ProtocolError::DeadlineExceeded)
    } else {
        Ok(())
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn peer_has_daemon_uid(stream: &UnixStream) -> bool {
    #[cfg(target_os = "linux")]
    {
        let mut credentials = libc::ucred {
            pid: 0,
            uid: 0,
            gid: 0,
        };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: credentials and length are valid writable pointers for SO_PEERCRED,
        // and the stream owns a valid socket file descriptor for this call.
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        result == 0
            && length as usize == std::mem::size_of::<libc::ucred>()
            && credentials.uid == effective_uid()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = stream;
        false
    }
}

pub(crate) fn read_bounded_frame<R: BufRead>(reader: &mut R) -> io::Result<FrameRead> {
    let mut frame = Vec::new();
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) =>
            {
                if SIGNAL_SHUTDOWN.load(Ordering::SeqCst) {
                    return Ok(FrameRead::Eof);
                }
                continue;
            }
            Err(error) => return Err(error),
        };
        if available.is_empty() {
            return Ok(if frame.is_empty() {
                FrameRead::Eof
            } else {
                FrameRead::Unterminated
            });
        }
        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if frame.len().saturating_add(newline) > MAX_FRAME_BYTES {
                reader.consume(newline + 1);
                return Ok(FrameRead::Oversized);
            }
            frame.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            return Ok(FrameRead::Frame(frame));
        }
        let available_len = available.len();
        if frame.len().saturating_add(available_len) > MAX_FRAME_BYTES {
            reader.consume(available_len);
            discard_through_newline(reader)?;
            return Ok(FrameRead::Oversized);
        }
        frame.extend_from_slice(available);
        reader.consume(available_len);
    }
}

fn discard_through_newline<R: BufRead>(reader: &mut R) -> io::Result<()> {
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) =>
            {
                if SIGNAL_SHUTDOWN.load(Ordering::SeqCst) {
                    return Ok(());
                }
                continue;
            }
            Err(error) => return Err(error),
        };
        if available.is_empty() || SIGNAL_SHUTDOWN.load(Ordering::SeqCst) {
            return Ok(());
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let found_newline = consumed <= available.len() && available[consumed - 1] == b'\n';
        reader.consume(consumed);
        if found_newline {
            return Ok(());
        }
    }
}

fn write_value(stream: &mut UnixStream, value: &Value) -> Result<(), ServerError> {
    let mut encoded = serde_json::to_vec(value).map_err(|error| {
        ServerError::io(
            "serializing response for",
            "socket",
            io::Error::other(error),
        )
    })?;
    if encoded.len() > MAX_FRAME_BYTES {
        return Err(ServerError::io(
            "writing response to",
            "socket",
            io::Error::new(io::ErrorKind::InvalidData, "response exceeds frame bound"),
        ));
    }
    encoded.push(b'\n');
    stream
        .write_all(&encoded)
        .map_err(|error| ServerError::io("writing response to", "socket", error))
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn frame_reader_bounds_and_recovers_after_oversized_frames() {
        let mut input = vec![b'x'; MAX_FRAME_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = Cursor::new(input);
        assert_eq!(
            read_bounded_frame(&mut reader).expect("oversized frame"),
            FrameRead::Oversized
        );
        assert_eq!(
            read_bounded_frame(&mut reader).expect("next frame"),
            FrameRead::Frame(b"{}".to_vec())
        );
    }

    #[test]
    fn frame_reader_rejects_unterminated_and_accepts_exact_bound() {
        let mut unterminated = Cursor::new(b"{}".to_vec());
        assert_eq!(
            read_bounded_frame(&mut unterminated).expect("unterminated"),
            FrameRead::Unterminated
        );
        let mut exact = vec![b'x'; MAX_FRAME_BYTES];
        exact.push(b'\n');
        assert_eq!(
            read_bounded_frame(&mut Cursor::new(exact)).expect("exact frame"),
            FrameRead::Frame(vec![b'x'; MAX_FRAME_BYTES])
        );
    }

    #[test]
    fn cli_paths_must_be_absolute_and_distinct() {
        let relative = ServerConfig {
            socket_path: PathBuf::from("index.sock"),
            database_path: PathBuf::from("index.db"),
            database_mode: DatabaseMode::Create,
        };
        assert!(validate_paths(&relative).is_err());
    }
}
