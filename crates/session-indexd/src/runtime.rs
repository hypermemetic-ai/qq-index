use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use qq_session_index_core::{
    CommitReceipt, IndexError, IndexMetadata, MutationBatch, SearchBatchResponseV1, SearchBatchV1,
    SessionIndex, SessionIndexReader, SourceStateV1,
    view_platform::{
        ViewCatalog, ViewDescriptionV1, ViewLifecycleV1, ViewMutationV1, ViewOperationReceiptV1,
        ViewPartitionStatesV1, ViewQueryResponseV1, ViewQueryV1,
    },
};
use rusqlite::InterruptHandle;

use crate::protocol::ProtocolError;

const PHASE_QUEUED: u8 = 0;
const PHASE_ACTIVE: u8 = 1;
const PHASE_TERMINAL: u8 = 2;
const CANCEL_NONE: u8 = 0;
const CANCEL_CALLER: u8 = 1;
const CANCEL_DEADLINE: u8 = 2;
const CANCEL_DISCONNECT: u8 = 3;
const INTERRUPT_GRACE: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CancelReason {
    Caller,
    Deadline,
    Disconnect,
}

impl CancelReason {
    fn code(self) -> u8 {
        match self {
            Self::Caller => CANCEL_CALLER,
            Self::Deadline => CANCEL_DEADLINE,
            Self::Disconnect => CANCEL_DISCONNECT,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CancelOutcome {
    Queued,
    Active,
    AlreadyTerminal,
    NotFound,
}

impl CancelOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Active => "active",
            Self::AlreadyTerminal => "terminal",
            Self::NotFound => "not-found",
        }
    }

    pub(crate) fn requested(self) -> bool {
        matches!(self, Self::Queued | Self::Active)
    }
}

struct SearchControl {
    request_id: String,
    phase: AtomicU8,
    reason: AtomicU8,
    cancelled: Arc<AtomicBool>,
    cancelled_unix_ms: AtomicU64,
    active_interrupt: Mutex<Option<Arc<InterruptHandle>>>,
    completion: Mutex<Option<SyncSender<SearchResult>>>,
}

impl SearchControl {
    fn new(request_id: String, completion: SyncSender<SearchResult>) -> Self {
        Self {
            request_id,
            phase: AtomicU8::new(PHASE_QUEUED),
            reason: AtomicU8::new(CANCEL_NONE),
            cancelled: Arc::new(AtomicBool::new(false)),
            cancelled_unix_ms: AtomicU64::new(0),
            active_interrupt: Mutex::new(None),
            completion: Mutex::new(Some(completion)),
        }
    }

    fn terminal_from_reason(&self) -> SearchTerminal {
        match self.reason.load(Ordering::Acquire) {
            CANCEL_DEADLINE => SearchTerminal::DeadlineExceeded,
            CANCEL_CALLER | CANCEL_DISCONNECT => SearchTerminal::Cancelled,
            _ => SearchTerminal::Storage(IndexError::InvalidSchema(
                "interrupted search had no cancellation reason".to_owned(),
            )),
        }
    }

    fn send(&self, result: SearchResult) {
        if let Ok(mut completion) = self.completion.lock()
            && let Some(completion) = completion.take()
        {
            let _ = completion.send(result);
        }
    }

    /// Publish a connection-specific interrupt handle and become active as one transition.
    /// The caller must already own the corresponding SQLite connection mutex.
    fn activate_interrupt(&self, interrupt: Arc<InterruptHandle>) -> bool {
        let Ok(mut active) = self.active_interrupt.lock() else {
            return false;
        };
        *active = Some(Arc::clone(&interrupt));
        if self
            .phase
            .compare_exchange(
                PHASE_QUEUED,
                PHASE_ACTIVE,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            *active = None;
            return false;
        }
        // Close the transition race: cancellation sets its flag before observing phase.
        if self.cancelled.load(Ordering::Acquire) {
            interrupt.interrupt();
        }
        true
    }

    /// Clear the published handle while the caller still owns its connection mutex.
    fn clear_interrupt(&self) {
        if let Ok(mut active) = self.active_interrupt.lock() {
            *active = None;
        }
    }
}

struct ReaderJob {
    deadline_unix_ms: u64,
    request: SearchBatchV1,
    control: Arc<SearchControl>,
}

type SearchResult = Result<SearchBatchResponseV1, SearchTerminal>;

enum SearchTerminal {
    Cancelled,
    DeadlineExceeded,
    Storage(IndexError),
}

enum WriterOperation {
    Metadata,
    SourceState(Vec<String>),
    Apply(MutationBatch),
}

enum WriterResponse {
    Metadata(IndexMetadata),
    SourceState(SourceStateV1),
    Apply(CommitReceipt),
}

struct WriterJob {
    deadline_unix_ms: u64,
    operation: WriterOperation,
    completion: SyncSender<Result<WriterResponse, IndexError>>,
}

pub(crate) struct Coordinator {
    reader_tx: SyncSender<ReaderJob>,
    writer_tx: SyncSender<WriterJob>,
    registry: Mutex<HashMap<String, Arc<SearchControl>>>,
    reader_count: usize,
    queue_capacity: usize,
    reader_retirements: Arc<AtomicU64>,
    active_readers: Arc<AtomicU64>,
    peak_active_readers: Arc<AtomicU64>,
    view_catalog: Mutex<Option<Arc<ViewCatalog>>>,
    #[cfg(test)]
    hooks: Arc<TestHooks>,
}

pub(crate) struct Runtime {
    coordinator: Arc<Coordinator>,
    handles: Vec<JoinHandle<()>>,
}

impl Runtime {
    pub(crate) fn start(
        writer: SessionIndex,
        database_path: &Path,
        reader_count: usize,
        queue_capacity: usize,
    ) -> Result<Self, IndexError> {
        let (reader_tx, reader_rx) = mpsc::sync_channel(queue_capacity);
        let reader_rx = Arc::new(Mutex::new(reader_rx));
        let (writer_tx, writer_rx) = mpsc::sync_channel(queue_capacity);
        let reader_retirements = Arc::new(AtomicU64::new(0));
        let active_readers = Arc::new(AtomicU64::new(0));
        let peak_active_readers = Arc::new(AtomicU64::new(0));
        #[cfg(test)]
        let hooks = Arc::new(TestHooks::default());

        // Open and validate every reader before any worker is detached. Startup is
        // all-or-nothing and reader open performs no schema/source work.
        let mut readers = Vec::with_capacity(reader_count);
        for _ in 0..reader_count {
            readers.push(SessionIndexReader::open(database_path)?);
        }

        let coordinator = Arc::new(Coordinator {
            reader_tx,
            writer_tx,
            registry: Mutex::new(HashMap::with_capacity(reader_count + queue_capacity)),
            reader_count,
            queue_capacity,
            reader_retirements: Arc::clone(&reader_retirements),
            active_readers: Arc::clone(&active_readers),
            peak_active_readers: Arc::clone(&peak_active_readers),
            view_catalog: Mutex::new(None),
            #[cfg(test)]
            hooks: Arc::clone(&hooks),
        });

        let mut handles = Vec::with_capacity(reader_count + 1);
        handles.push(
            thread::Builder::new()
                .name("qq-session-index-writer".to_owned())
                .spawn(move || writer_worker(writer, writer_rx))
                .map_err(thread_error)?,
        );
        let database_path = database_path.to_path_buf();
        for (worker_id, reader) in readers.into_iter().enumerate() {
            let jobs = Arc::clone(&reader_rx);
            let registry_owner = Arc::downgrade(&coordinator);
            let path = database_path.clone();
            let retirements = Arc::clone(&reader_retirements);
            let worker_active_readers = Arc::clone(&active_readers);
            let worker_peak_active_readers = Arc::clone(&peak_active_readers);
            #[cfg(test)]
            let worker_hooks = Arc::clone(&hooks);
            handles.push(
                thread::Builder::new()
                    .name(format!("qq-session-index-reader-{worker_id}"))
                    .spawn(move || {
                        reader_worker(
                            worker_id,
                            reader,
                            &path,
                            jobs,
                            registry_owner,
                            retirements,
                            worker_active_readers,
                            worker_peak_active_readers,
                            #[cfg(test)]
                            worker_hooks,
                        );
                    })
                    .map_err(thread_error)?,
            );
        }
        Ok(Self {
            coordinator,
            handles,
        })
    }

    pub(crate) fn coordinator(&self) -> Arc<Coordinator> {
        Arc::clone(&self.coordinator)
    }

    pub(crate) fn shutdown(self) {
        // Client threads have been joined by the server. Dropping the final
        // coordinator closes both bounded channels and lets every worker exit.
        drop(self.coordinator);
        for handle in self.handles {
            let _ = handle.join();
        }
    }
}

impl Coordinator {
    pub(crate) fn install_view_catalog(&self, catalog: ViewCatalog) -> Result<(), ProtocolError> {
        let mut installed = self.view_catalog.lock().map_err(|_| lock_error())?;
        if installed.is_some() {
            return Err(ProtocolError::StorageUnavailable);
        }
        *installed = Some(Arc::new(catalog));
        Ok(())
    }

    fn view_catalog(&self) -> Result<Arc<ViewCatalog>, ProtocolError> {
        self.view_catalog
            .lock()
            .map_err(|_| lock_error())?
            .clone()
            .ok_or(ProtocolError::StorageUnavailable)
    }

    pub(crate) fn describe_views(
        &self,
        deadline: u64,
    ) -> Result<Vec<ViewDescriptionV1>, ProtocolError> {
        ensure_deadline(deadline)?;
        let result = self
            .view_catalog()?
            .describe()
            .map_err(ProtocolError::from)?;
        ensure_deadline(deadline)?;
        Ok(result)
    }

    pub(crate) fn view_partition_states(
        &self,
        deadline: u64,
        view: &qq_session_index_core::view_platform::ViewIdentityV1,
        partition_keys: &[String],
    ) -> Result<ViewPartitionStatesV1, ProtocolError> {
        ensure_deadline(deadline)?;
        let result = self
            .view_catalog()?
            .partition_states(view, partition_keys)
            .map_err(ProtocolError::from)?;
        ensure_deadline(deadline)?;
        Ok(result)
    }

    pub(crate) fn mutate_view(
        &self,
        deadline: u64,
        mutation: &ViewMutationV1,
    ) -> Result<ViewOperationReceiptV1, ProtocolError> {
        ensure_deadline(deadline)?;
        let result = self
            .view_catalog()?
            .apply_mutation(mutation)
            .map_err(ProtocolError::from)?;
        ensure_deadline(deadline)?;
        Ok(result)
    }

    pub(crate) fn set_view_lifecycle(
        &self,
        deadline: u64,
        lifecycle: &ViewLifecycleV1,
    ) -> Result<ViewOperationReceiptV1, ProtocolError> {
        ensure_deadline(deadline)?;
        let result = self
            .view_catalog()?
            .apply_lifecycle(lifecycle)
            .map_err(ProtocolError::from)?;
        ensure_deadline(deadline)?;
        Ok(result)
    }

    pub(crate) fn query_view(
        &self,
        request_id: String,
        deadline_unix_ms: u64,
        query: &ViewQueryV1,
    ) -> Result<ViewQueryResponseV1, ProtocolError> {
        ensure_deadline(deadline_unix_ms)?;
        let catalog = self.view_catalog()?;
        let (completion, _response) = mpsc::sync_channel(1);
        let control = Arc::new(SearchControl::new(request_id.clone(), completion));
        {
            let mut registry = self.registry.lock().map_err(|_| lock_error())?;
            if registry.contains_key(&request_id) {
                return Err(ProtocolError::DuplicateRequestId);
            }
            if registry.len() >= self.reader_count + self.queue_capacity {
                return Err(ProtocolError::AdmissionRejected);
            }
            registry.insert(request_id.clone(), Arc::clone(&control));
        }

        let activating_control = Arc::clone(&control);
        let releasing_control = Arc::clone(&control);
        #[cfg(test)]
        let activating_hooks = Arc::clone(&self.hooks);
        #[cfg(test)]
        let releasing_hooks = Arc::clone(&self.hooks);
        #[cfg(test)]
        let activating_request_id = request_id.clone();
        #[cfg(test)]
        let releasing_request_id = request_id;
        let result = catalog.query_controlled_with_lease(
            query,
            Arc::clone(&control.cancelled),
            deadline_unix_ms,
            move |interrupt| {
                let activated = activating_control.activate_interrupt(interrupt);
                #[cfg(test)]
                if activated {
                    activating_hooks.view_phase(&activating_request_id, ViewQueryTestPhase::Active);
                }
                activated
            },
            move || {
                releasing_control.clear_interrupt();
                #[cfg(test)]
                releasing_hooks.view_phase(&releasing_request_id, ViewQueryTestPhase::Releasing);
            },
        );
        control.phase.store(PHASE_TERMINAL, Ordering::Release);
        self.remove_control(&control);

        if control.reason.load(Ordering::Acquire) != CANCEL_NONE
            || now_unix_ms() >= deadline_unix_ms
            || matches!(
                result,
                Err(qq_session_index_core::view_platform::ViewError::Interrupted)
            )
        {
            return Err(control_protocol_error(&control, deadline_unix_ms));
        }
        result.map_err(ProtocolError::from)
    }

    pub(crate) fn reader_count(&self) -> usize {
        self.reader_count
    }

    pub(crate) fn queue_capacity(&self) -> usize {
        self.queue_capacity
    }

    pub(crate) fn reader_retirements(&self) -> u64 {
        self.reader_retirements.load(Ordering::Relaxed)
    }

    pub(crate) fn active_readers(&self) -> u64 {
        self.active_readers.load(Ordering::Relaxed)
    }

    pub(crate) fn peak_active_readers(&self) -> u64 {
        self.peak_active_readers
            .load(Ordering::Acquire)
            .max(self.active_readers.load(Ordering::Acquire))
    }

    pub(crate) fn search(
        &self,
        request_id: String,
        deadline_unix_ms: u64,
        request: SearchBatchV1,
    ) -> Result<SearchBatchResponseV1, ProtocolError> {
        if now_unix_ms() >= deadline_unix_ms {
            return Err(ProtocolError::DeadlineExceeded);
        }
        let (completion, response) = mpsc::sync_channel(1);
        let control = Arc::new(SearchControl::new(request_id.clone(), completion));
        {
            let mut registry = self.registry.lock().map_err(|_| lock_error())?;
            if registry.contains_key(&request_id) {
                return Err(ProtocolError::DuplicateRequestId);
            }
            // The map is bounded by exactly the number of active workers plus
            // jobs admitted to the bounded queue.
            if registry.len() >= self.reader_count + self.queue_capacity {
                return Err(ProtocolError::AdmissionRejected);
            }
            registry.insert(request_id, Arc::clone(&control));
        }
        let job = ReaderJob {
            deadline_unix_ms,
            request,
            control: Arc::clone(&control),
        };
        match self.reader_tx.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.remove_control(&control);
                return Err(ProtocolError::AdmissionRejected);
            }
            Err(TrySendError::Disconnected(_)) => {
                self.remove_control(&control);
                return Err(ProtocolError::StorageUnavailable);
            }
        }

        let remaining = duration_until(deadline_unix_ms);
        let result = match response.recv_timeout(remaining) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.cancel_exact(&control, CancelReason::Deadline);
                match response.recv_timeout(INTERRUPT_GRACE) {
                    Ok(result) => result,
                    Err(RecvTimeoutError::Timeout) => {
                        // The worker remains occupied. Its elapsed cancellation
                        // time forces a close/reopen before it takes another job.
                        return Err(ProtocolError::DeadlineExceeded);
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        return Err(ProtocolError::StorageUnavailable);
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(ProtocolError::StorageUnavailable);
            }
        };
        match result {
            Ok(response) => Ok(response),
            Err(SearchTerminal::Cancelled) => Err(ProtocolError::Cancelled),
            Err(SearchTerminal::DeadlineExceeded) => Err(ProtocolError::DeadlineExceeded),
            Err(SearchTerminal::Storage(error)) => Err(ProtocolError::Core(error)),
        }
    }

    pub(crate) fn cancel(
        &self,
        target_request_id: &str,
        reason: CancelReason,
    ) -> Result<CancelOutcome, ProtocolError> {
        let control = self
            .registry
            .lock()
            .map_err(|_| lock_error())?
            .get(target_request_id)
            .cloned();
        Ok(match control {
            Some(control) => self.cancel_exact(&control, reason),
            None => CancelOutcome::NotFound,
        })
    }

    fn cancel_exact(&self, control: &Arc<SearchControl>, reason: CancelReason) -> CancelOutcome {
        let _ = control.reason.compare_exchange(
            CANCEL_NONE,
            reason.code(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        control.cancelled.store(true, Ordering::Release);
        let _ = control.cancelled_unix_ms.compare_exchange(
            0,
            now_unix_ms(),
            Ordering::AcqRel,
            Ordering::Acquire,
        );

        loop {
            match control.phase.load(Ordering::Acquire) {
                PHASE_QUEUED => {
                    if control
                        .phase
                        .compare_exchange(
                            PHASE_QUEUED,
                            PHASE_TERMINAL,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        control.send(Err(control.terminal_from_reason()));
                        self.remove_control(control);
                        return CancelOutcome::Queued;
                    }
                }
                PHASE_ACTIVE => {
                    if let Ok(active) = control.active_interrupt.lock()
                        && let Some(handle) = active.as_ref()
                    {
                        handle.interrupt();
                    }
                    return CancelOutcome::Active;
                }
                _ => return CancelOutcome::AlreadyTerminal,
            }
        }
    }

    fn remove_control(&self, control: &Arc<SearchControl>) {
        if let Ok(mut registry) = self.registry.lock()
            && registry
                .get(&control.request_id)
                .is_some_and(|stored| Arc::ptr_eq(stored, control))
        {
            registry.remove(&control.request_id);
        }
    }

    pub(crate) fn metadata(&self, deadline: u64) -> Result<IndexMetadata, ProtocolError> {
        match self.writer_call(deadline, WriterOperation::Metadata)? {
            WriterResponse::Metadata(value) => Ok(value),
            _ => Err(ProtocolError::StorageUnavailable),
        }
    }

    pub(crate) fn source_state(
        &self,
        deadline: u64,
        session_ids: Vec<String>,
    ) -> Result<SourceStateV1, ProtocolError> {
        match self.writer_call(deadline, WriterOperation::SourceState(session_ids))? {
            WriterResponse::SourceState(value) => Ok(value),
            _ => Err(ProtocolError::StorageUnavailable),
        }
    }

    pub(crate) fn apply_batch(
        &self,
        deadline: u64,
        batch: MutationBatch,
    ) -> Result<CommitReceipt, ProtocolError> {
        match self.writer_call(deadline, WriterOperation::Apply(batch))? {
            WriterResponse::Apply(value) => Ok(value),
            _ => Err(ProtocolError::StorageUnavailable),
        }
    }

    fn writer_call(
        &self,
        deadline_unix_ms: u64,
        operation: WriterOperation,
    ) -> Result<WriterResponse, ProtocolError> {
        if now_unix_ms() >= deadline_unix_ms {
            return Err(ProtocolError::DeadlineExceeded);
        }
        let (completion, response) = mpsc::sync_channel(1);
        let job = WriterJob {
            deadline_unix_ms,
            operation,
            completion,
        };
        match self.writer_tx.try_send(job) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(ProtocolError::AdmissionRejected),
            Err(TrySendError::Disconnected(_)) => return Err(ProtocolError::StorageUnavailable),
        }
        match response.recv_timeout(duration_until(deadline_unix_ms)) {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(error)) => Err(ProtocolError::Core(error)),
            Err(RecvTimeoutError::Timeout) => Err(ProtocolError::DeadlineExceeded),
            Err(RecvTimeoutError::Disconnected) => Err(ProtocolError::StorageUnavailable),
        }
    }
}

fn writer_worker(index: SessionIndex, jobs: Receiver<WriterJob>) {
    while let Ok(job) = jobs.recv() {
        if now_unix_ms() >= job.deadline_unix_ms {
            // Dropping the completion makes the caller's already-bounded deadline
            // terminal; expired queued mutations never enter SQLite.
            continue;
        }
        let response = match job.operation {
            WriterOperation::Metadata => index.metadata().map(WriterResponse::Metadata),
            WriterOperation::SourceState(session_ids) => index
                .source_state_v1(&session_ids)
                .map(WriterResponse::SourceState),
            WriterOperation::Apply(batch) => index.apply_batch(&batch).map(WriterResponse::Apply),
        };
        let _ = job.completion.send(response);
    }
}

#[allow(clippy::too_many_arguments)]
fn reader_worker(
    #[cfg_attr(not(test), allow(unused_variables))] worker_id: usize,
    mut reader: SessionIndexReader,
    database_path: &PathBuf,
    jobs: Arc<Mutex<Receiver<ReaderJob>>>,
    registry_owner: std::sync::Weak<Coordinator>,
    retirements: Arc<AtomicU64>,
    active_readers: Arc<AtomicU64>,
    peak_active_readers: Arc<AtomicU64>,
    #[cfg(test)] hooks: Arc<TestHooks>,
) {
    loop {
        let job = {
            let Ok(receiver) = jobs.lock() else {
                return;
            };
            receiver.recv()
        };
        let Ok(job) = job else {
            return;
        };
        if now_unix_ms() >= job.deadline_unix_ms {
            if let Some(owner) = registry_owner.upgrade() {
                owner.cancel_exact(&job.control, CancelReason::Deadline);
            }
            continue;
        }
        if job
            .control
            .phase
            .compare_exchange(
                PHASE_QUEUED,
                PHASE_ACTIVE,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            continue;
        }

        let active_now = active_readers.fetch_add(1, Ordering::AcqRel) + 1;
        peak_active_readers.fetch_max(active_now, Ordering::AcqRel);

        let interrupt = Arc::new(reader.interrupt_handle());
        if let Ok(mut active) = job.control.active_interrupt.lock() {
            *active = Some(Arc::clone(&interrupt));
        }
        // Close the transition race: cancellation can set its flag before the
        // worker publishes the handle.
        if job.control.cancelled.load(Ordering::Acquire) {
            interrupt.interrupt();
        }

        #[cfg(test)]
        hooks.before_search(worker_id, &job.control.request_id);
        #[cfg(test)]
        let response = if let Some(progress_hook) = hooks.progress_hook() {
            let request_id = job.control.request_id.clone();
            reader.search_batch_v1_with_test_progress_hook(
                &job.request,
                Arc::clone(&job.control.cancelled),
                Arc::new(move || progress_hook(worker_id, &request_id)),
            )
        } else {
            reader.search_batch_v1(&job.request, Arc::clone(&job.control.cancelled))
        };
        #[cfg(not(test))]
        let response = reader.search_batch_v1(&job.request, Arc::clone(&job.control.cancelled));
        active_readers.fetch_sub(1, Ordering::AcqRel);
        #[cfg(test)]
        let forced_retirement = hooks.take_forced_retirement(&job.control.request_id);
        #[cfg(not(test))]
        let forced_retirement = false;

        if let Ok(mut active) = job.control.active_interrupt.lock() {
            *active = None;
        }
        let result = if job.control.reason.load(Ordering::Acquire) != CANCEL_NONE {
            Err(job.control.terminal_from_reason())
        } else {
            response.map_err(SearchTerminal::Storage)
        };
        job.control.phase.store(PHASE_TERMINAL, Ordering::Release);
        job.control.send(result);
        if let Some(owner) = registry_owner.upgrade() {
            owner.remove_control(&job.control);
        }

        let cancelled_at = job.control.cancelled_unix_ms.load(Ordering::Acquire);
        let slow_unwind = cancelled_at != 0
            && now_unix_ms().saturating_sub(cancelled_at)
                > INTERRUPT_GRACE.as_millis().try_into().unwrap_or(u64::MAX);
        if forced_retirement || slow_unwind {
            // Drop the interrupted connection before opening its replacement;
            // the worker cannot receive another job until replacement validates.
            match SessionIndexReader::open(database_path) {
                Ok(replacement) => {
                    reader = replacement;
                    retirements.fetch_add(1, Ordering::Relaxed);
                }
                Err(_) => return,
            }
        }
    }
}

fn thread_error(error: std::io::Error) -> IndexError {
    IndexError::InvalidSchema(format!("failed to spawn daemon worker: {error}"))
}

fn lock_error() -> ProtocolError {
    ProtocolError::StorageUnavailable
}

fn control_protocol_error(control: &SearchControl, deadline_unix_ms: u64) -> ProtocolError {
    match control.reason.load(Ordering::Acquire) {
        CANCEL_DEADLINE => ProtocolError::DeadlineExceeded,
        CANCEL_CALLER | CANCEL_DISCONNECT => ProtocolError::Cancelled,
        _ if now_unix_ms() >= deadline_unix_ms => ProtocolError::DeadlineExceeded,
        _ => ProtocolError::Cancelled,
    }
}

fn ensure_deadline(deadline_unix_ms: u64) -> Result<(), ProtocolError> {
    if now_unix_ms() >= deadline_unix_ms {
        Err(ProtocolError::DeadlineExceeded)
    } else {
        Ok(())
    }
}

fn duration_until(deadline_unix_ms: u64) -> Duration {
    Duration::from_millis(deadline_unix_ms.saturating_sub(now_unix_ms()))
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
type ReaderHook = Arc<dyn Fn(usize, &str) + Send + Sync>;

#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ViewQueryTestPhase {
    Active,
    Releasing,
}

#[cfg(test)]
type ViewQueryHook = Arc<dyn Fn(&str, ViewQueryTestPhase) + Send + Sync>;

#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    before: Mutex<Option<ReaderHook>>,
    progress: Mutex<Option<ReaderHook>>,
    force_retire: Mutex<Vec<String>>,
    view_query: Mutex<Option<ViewQueryHook>>,
}

#[cfg(test)]
impl TestHooks {
    fn before_search(&self, worker_id: usize, request_id: &str) {
        let hook = self.before.lock().ok().and_then(|hook| hook.clone());
        if let Some(hook) = hook {
            hook(worker_id, request_id);
        }
    }

    fn progress_hook(&self) -> Option<ReaderHook> {
        self.progress.lock().ok().and_then(|hook| hook.clone())
    }

    fn view_phase(&self, request_id: &str, phase: ViewQueryTestPhase) {
        let hook = self.view_query.lock().ok().and_then(|hook| hook.clone());
        if let Some(hook) = hook {
            hook(request_id, phase);
        }
    }

    fn take_forced_retirement(&self, request_id: &str) -> bool {
        let Ok(mut ids) = self.force_retire.lock() else {
            return false;
        };
        let Some(index) = ids.iter().position(|id| id == request_id) else {
            return false;
        };
        ids.swap_remove(index);
        true
    }
}

#[cfg(test)]
impl Coordinator {
    fn test_set_before_search(&self, hook: ReaderHook) {
        *self.hooks.before.lock().expect("test hook lock") = Some(hook);
    }

    fn test_clear_before_search(&self) {
        *self.hooks.before.lock().expect("test hook lock") = None;
    }

    fn test_set_progress_hook(&self, hook: ReaderHook) {
        *self.hooks.progress.lock().expect("progress hook lock") = Some(hook);
    }

    fn test_clear_progress_hook(&self) {
        *self.hooks.progress.lock().expect("progress hook lock") = None;
    }

    fn test_set_view_query_hook(&self, hook: ViewQueryHook) {
        *self.hooks.view_query.lock().expect("view query hook lock") = Some(hook);
    }

    fn test_clear_view_query_hook(&self) {
        *self.hooks.view_query.lock().expect("view query hook lock") = None;
    }

    fn test_control_state(&self, request_id: &str) -> Option<(u8, bool)> {
        let control = self
            .registry
            .lock()
            .expect("registry lock")
            .get(request_id)
            .cloned()?;
        let phase = control.phase.load(Ordering::Acquire);
        let has_interrupt = control
            .active_interrupt
            .lock()
            .expect("active interrupt lock")
            .is_some();
        Some((phase, has_interrupt))
    }

    fn test_force_retirement(&self, request_id: &str) {
        self.hooks
            .force_retire
            .lock()
            .expect("retirement hook lock")
            .push(request_id.to_owned());
    }

    fn test_registry_len(&self) -> usize {
        self.registry.lock().expect("registry lock").len()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::{Barrier, Condvar};
    use std::time::Instant;

    use qq_session_index_core::{
        ProjectedDocument, SearchFiltersV1,
        view_platform::{
            ViewAuthorityV1, ViewFreshnessV1, ViewIdentityV1, ViewLifecycleV1, ViewMutationV1,
            ViewSourceCheckpointV1,
        },
    };
    use serde_json::json;

    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, SessionIndex) {
        let root = tempfile::tempdir().expect("generated temporary directory");
        let path = root.path().join("scheduler-generated.db");
        let index = SessionIndex::create(&path).expect("create generated scheduler index");
        index
            .apply_batch(&MutationBatch {
                idempotency_key: "scheduler-seed".to_owned(),
                payload_fingerprint: "scheduler-seed-payload".to_owned(),
                source_watermark: 1,
                documents: (0..300)
                    .map(|ordinal| ProjectedDocument {
                        session_id: format!("scheduler-session-{ordinal}"),
                        seq: 0,
                        event_time_unix_ms: 1_700_000_000_000 + ordinal,
                        event_type: "message/generated".to_owned(),
                        surface: "conversation".to_owned(),
                        workspace_id: "workspace-generated".to_owned(),
                        scope_tokens: vec!["scopegenerated".to_owned()],
                        body: "generated scheduler overlap phrase".to_owned(),
                        fingerprint: format!("scheduler-fingerprint-{ordinal}"),
                        source_revision: format!("scheduler-revision-{ordinal}"),
                    })
                    .collect(),
            })
            .expect("seed scheduler fixture");
        (root, path, index)
    }

    fn search() -> SearchBatchV1 {
        SearchBatchV1 {
            literals: vec!["generated".to_owned()],
            per_source_depth: 100,
            final_limit: 100,
            filters: SearchFiltersV1 {
                authorized_scope_terms: vec!["scopegenerated".to_owned()],
                ..SearchFiltersV1::default()
            },
            minimum_source_watermark: None,
        }
    }

    #[test]
    fn two_reader_jobs_overlap_on_distinct_workers_and_connections() {
        let (_root, path, writer) = fixture();
        let runtime = Runtime::start(writer, &path, 2, 2).expect("start reader pool");
        let coordinator = runtime.coordinator();
        let entered = Arc::new(Barrier::new(3));
        let release = Arc::new(Barrier::new(3));
        let workers = Arc::new(Mutex::new(Vec::new()));
        coordinator.test_set_before_search(Arc::new({
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            let workers = Arc::clone(&workers);
            move |worker_id, _request_id| {
                workers.lock().expect("workers lock").push(worker_id);
                entered.wait();
                release.wait();
            }
        }));

        let first = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("overlap-a".to_owned(), now_unix_ms() + 2_000, search())
            })
        };
        let second = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("overlap-b".to_owned(), now_unix_ms() + 2_000, search())
            })
        };
        entered.wait();
        let observed = workers.lock().expect("workers lock").clone();
        assert_eq!(observed.len(), 2);
        assert_eq!(observed.into_iter().collect::<BTreeSet<_>>().len(), 2);
        release.wait();
        assert!(first.join().expect("join first overlap").is_ok());
        assert!(second.join().expect("join second overlap").is_ok());
        coordinator.test_clear_before_search();
        drop(coordinator);
        runtime.shutdown();
    }

    #[test]
    fn bounded_queue_rejects_and_queued_deadline_never_enters_sqlite() {
        let (_root, path, writer) = fixture();
        let runtime = Runtime::start(writer, &path, 1, 1).expect("start bounded pool");
        let coordinator = runtime.coordinator();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let entered_ids = Arc::new(Mutex::new(Vec::new()));
        coordinator.test_set_before_search(Arc::new({
            let gate = Arc::clone(&gate);
            let entered_ids = Arc::clone(&entered_ids);
            move |_worker_id, request_id| {
                entered_ids
                    .lock()
                    .expect("entered ids lock")
                    .push(request_id.to_owned());
                let (open, wake) = &*gate;
                let mut open = open.lock().expect("gate lock");
                while !*open {
                    open = wake.wait(open).expect("gate wait");
                }
            }
        }));
        let active = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("queue-active".to_owned(), now_unix_ms() + 2_000, search())
            })
        };
        while coordinator.test_registry_len() != 1 {
            thread::yield_now();
        }
        let queued = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("queue-expired".to_owned(), now_unix_ms() + 40, search())
            })
        };
        while coordinator.test_registry_len() != 2 {
            thread::yield_now();
        }
        let rejected =
            coordinator.search("queue-rejected".to_owned(), now_unix_ms() + 1_000, search());
        assert!(matches!(rejected, Err(ProtocolError::AdmissionRejected)));
        let started = Instant::now();
        assert!(matches!(
            queued.join().expect("join queued deadline"),
            Err(ProtocolError::DeadlineExceeded)
        ));
        assert!(started.elapsed() < Duration::from_millis(200));
        assert_eq!(
            entered_ids.lock().expect("entered ids lock").as_slice(),
            ["queue-active"]
        );
        let (open, wake) = &*gate;
        *open.lock().expect("gate lock") = true;
        wake.notify_all();
        assert!(active.join().expect("join active").is_ok());
        coordinator.test_clear_before_search();
        drop(coordinator);
        runtime.shutdown();
    }

    #[test]
    fn view_mutex_lease_keeps_waiters_queued_and_out_of_legacy_reader_metrics() {
        const TOKEN: &str = "waaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let (_root, path, writer) = fixture();
        let catalog = ViewCatalog::create(&path).expect("create generated view catalog");
        let exact = ViewIdentityV1 {
            id: "qq.test.exact-range".to_owned(),
            version: 1,
        };
        catalog
            .apply_mutation(&ViewMutationV1::ReplacePartition {
                view: exact.clone(),
                partition_key: "lease-bucket".to_owned(),
                source: ViewSourceCheckpointV1 {
                    source_identity: "lease-source".to_owned(),
                    durable_revision: "lease-revision-1".to_owned(),
                    next_cursor: 1,
                    source_fence: "lease-fence-1".to_owned(),
                    lag_ms: 0,
                },
                rows: vec![json!({
                    "rowKey":"lease-row", "exactKey":"status", "ordinal":1,
                    "workspaceScopeToken":TOKEN, "value":"ready"
                })],
            })
            .expect("seed exact view for lease test");
        catalog
            .apply_lifecycle(&ViewLifecycleV1::Activate {
                view: exact.clone(),
                source_fence: "lease-live".to_owned(),
                lag_ms: 0,
            })
            .expect("activate exact view for lease test");

        let runtime = Runtime::start(writer, &path, 2, 2).expect("start view lease runtime");
        let coordinator = runtime.coordinator();
        coordinator
            .install_view_catalog(catalog)
            .expect("install view lease catalog");
        let query = ViewQueryV1 {
            view: exact,
            access: "exact-range".to_owned(),
            params: json!({"exactKey":"status", "minimum":0, "maximum":10, "limit":10}),
            authority: ViewAuthorityV1 {
                kind: "workspace-token-set/v1".to_owned(),
                scope_tokens: vec![TOKEN.to_owned()],
            },
            freshness: ViewFreshnessV1 {
                mode: "caught-up".to_owned(),
                max_lag_ms: 0,
            },
        };

        let (owner_entered_tx, owner_entered_rx) = mpsc::sync_channel(1);
        let owner_gate = Arc::new((Mutex::new(false), Condvar::new()));
        let observations = Arc::new(Mutex::new(Vec::new()));
        let weak_coordinator = Arc::downgrade(&coordinator);
        coordinator.test_set_view_query_hook(Arc::new({
            let owner_gate = Arc::clone(&owner_gate);
            let observations = Arc::clone(&observations);
            move |request_id, phase| {
                let state = weak_coordinator
                    .upgrade()
                    .and_then(|coordinator| coordinator.test_control_state(request_id))
                    .expect("control remains registered during lease callback");
                observations.lock().expect("lease observations lock").push((
                    request_id.to_owned(),
                    phase,
                    state,
                ));
                if request_id == "view-owner" && phase == ViewQueryTestPhase::Active {
                    owner_entered_tx
                        .send(())
                        .expect("announce owner acquired view mutex");
                    let (open, wake) = &*owner_gate;
                    let mut open = open.lock().expect("owner gate lock");
                    while !*open {
                        open = wake.wait(open).expect("owner gate wait");
                    }
                }
            }
        }));

        let owner = {
            let coordinator = Arc::clone(&coordinator);
            let query = query.clone();
            thread::spawn(move || {
                coordinator.query_view("view-owner".to_owned(), now_unix_ms() + 5_000, &query)
            })
        };
        owner_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("owner activated while holding view mutex");
        assert_eq!(
            coordinator.test_control_state("view-owner"),
            Some((PHASE_ACTIVE, true)),
            "active owner must publish its matching interrupt handle",
        );
        assert_eq!(coordinator.reader_count(), 2);
        assert_eq!(
            coordinator.active_readers(),
            0,
            "V2 view owner must not consume a legacy reader slot",
        );
        assert_eq!(
            coordinator.peak_active_readers(),
            0,
            "V2 view activity must not change legacy peak reader telemetry",
        );

        let waiter = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.query_view("view-waiter".to_owned(), now_unix_ms() + 5_000, &query)
            })
        };
        let wait_started = Instant::now();
        loop {
            if coordinator.test_control_state("view-waiter") == Some((PHASE_QUEUED, false)) {
                break;
            }
            assert!(
                wait_started.elapsed() < Duration::from_secs(1),
                "waiter never remained queued without an interrupt handle",
            );
            thread::yield_now();
        }
        assert_eq!(
            coordinator
                .cancel("view-waiter", CancelReason::Caller)
                .expect("cancel queued view waiter"),
            CancelOutcome::Queued,
        );
        assert!(matches!(
            waiter.join().expect("join cancelled view waiter"),
            Err(ProtocolError::Cancelled)
        ));
        assert_eq!(
            coordinator.test_control_state("view-owner"),
            Some((PHASE_ACTIVE, true)),
            "cancelling queued B must not clear or interrupt active A",
        );

        let (open, wake) = &*owner_gate;
        *open.lock().expect("owner gate lock") = true;
        wake.notify_all();
        assert!(owner.join().expect("join unaffected view owner").is_ok());
        coordinator.test_clear_view_query_hook();

        let observations = observations.lock().expect("lease observations lock");
        assert!(observations.contains(&(
            "view-owner".to_owned(),
            ViewQueryTestPhase::Active,
            (PHASE_ACTIVE, true),
        )));
        assert!(observations.contains(&(
            "view-owner".to_owned(),
            ViewQueryTestPhase::Releasing,
            (PHASE_ACTIVE, false),
        )));
        assert!(
            observations
                .iter()
                .all(|(request_id, _, _)| request_id != "view-waiter"),
            "a cancelled queued waiter must never acquire or publish the owner's handle",
        );
        drop(observations);
        assert_eq!(coordinator.active_readers(), 0);
        assert_eq!(coordinator.peak_active_readers(), 0);
        drop(coordinator);
        runtime.shutdown();
    }

    #[test]
    fn active_sqlite_interrupt_is_isolated_reusable_and_retirement_reopens() {
        let (_root, path, writer) = fixture();
        let runtime = Runtime::start(writer, &path, 2, 2).expect("start cancellation pool");
        let coordinator = runtime.coordinator();
        let (entered_tx, entered_rx) = mpsc::sync_channel(1);
        let entered_once = Arc::new(AtomicBool::new(false));
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        coordinator.test_set_progress_hook(Arc::new({
            let entered_once = Arc::clone(&entered_once);
            let gate = Arc::clone(&gate);
            move |_worker_id, request_id| {
                if request_id != "cancel-a" || entered_once.swap(true, Ordering::AcqRel) {
                    return;
                }
                entered_tx
                    .send(())
                    .expect("announce active SQLite progress callback");
                let (open, wake) = &*gate;
                let mut open = open.lock().expect("progress gate lock");
                while !*open {
                    open = wake.wait(open).expect("progress gate wait");
                }
            }
        }));
        let first = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("cancel-a".to_owned(), now_unix_ms() + 2_000, search())
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("search A entered SQLite VM");

        // B must execute on the other connection while A is paused inside SQLite.
        let second = {
            let coordinator = Arc::clone(&coordinator);
            thread::spawn(move || {
                coordinator.search("cancel-b".to_owned(), now_unix_ms() + 2_000, search())
            })
        };
        assert!(second.join().expect("join unaffected B").is_ok());
        assert_eq!(
            coordinator
                .cancel("cancel-a", CancelReason::Caller)
                .expect("interrupt active A"),
            CancelOutcome::Active
        );
        let (open, wake) = &*gate;
        *open.lock().expect("progress gate lock") = true;
        wake.notify_all();
        assert!(matches!(
            first.join().expect("join cancelled A"),
            Err(ProtocolError::Cancelled)
        ));
        coordinator.test_clear_progress_hook();
        coordinator
            .search("after-cancel".to_owned(), now_unix_ms() + 2_000, search())
            .expect("reader pool remains usable after SQLite interrupt/reset");

        coordinator.test_force_retirement("force-retire");
        coordinator
            .search("force-retire".to_owned(), now_unix_ms() + 2_000, search())
            .expect("search before forced reopen");
        let started = Instant::now();
        while coordinator.reader_retirements() == 0 && started.elapsed() < Duration::from_secs(1) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(coordinator.reader_retirements(), 1);
        coordinator
            .search("after-retire".to_owned(), now_unix_ms() + 2_000, search())
            .expect("replacement reader remains usable");
        drop(coordinator);
        runtime.shutdown();
    }
}
