use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::net::Shutdown;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use qq_session_indexd::{DatabaseMode, PROTOCOL_VERSION, ServerConfig, run};
use serde_json::{Value, json};

const DEADLINE: u64 = 9_999_999_999_999;

fn start(config: ServerConfig) -> thread::JoinHandle<Result<(), qq_session_indexd::ServerError>> {
    thread::spawn(move || run(&config))
}

fn connect_bounded(path: &Path) -> UnixStream {
    let started = Instant::now();
    loop {
        match UnixStream::connect(path) {
            Ok(stream) => return stream,
            Err(error) if started.elapsed() < Duration::from_secs(5) => {
                let _ = error;
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("daemon did not become ready: {error}"),
        }
    }
}

fn call(reader: &mut BufReader<UnixStream>, request_id: &str, operation: Value) -> Value {
    let request = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "deadlineUnixMs": DEADLINE,
        "operation": operation,
    });
    let mut encoded = serde_json::to_vec(&request).expect("serialize generated request");
    encoded.push(b'\n');
    reader
        .get_mut()
        .write_all(&encoded)
        .expect("write generated request");
    let mut response = String::new();
    reader
        .read_line(&mut response)
        .expect("read daemon response");
    assert!(!response.is_empty(), "daemon closed without a response");
    serde_json::from_str(&response).expect("parse daemon response")
}

fn shutdown(reader: &mut BufReader<UnixStream>) {
    let response = call(reader, "shutdown", json!({ "type": "shutdown" }));
    assert_eq!(response["ok"], true);
    assert_eq!(response["response"]["type"], "shutdown");
}

fn search_operation() -> Value {
    json!({
        "type": "searchBatch",
        "version": "search-batch-v1",
        "literals": [
            "amber telescope",
            "cobalt orchard",
            "velvet compass",
            "silver meadow",
            "juniper lantern"
        ],
        "perSourceDepth": 10,
        "finalLimit": 10,
        "filters": {
            "authorizedScopeTokens": ["scopegenerated"],
            "workspaceIds": [],
            "surfaceAllowList": [],
            "eventTypeAllowList": ["message/generated"]
        }
    })
}

#[test]
fn create_apply_search_shutdown_restart_and_socket_safety() {
    let root = tempfile::tempdir().expect("temporary generated root");
    let socket = root.path().join("private").join("index.sock");
    let database = root.path().join("generated.db");
    let create_config = ServerConfig {
        socket_path: socket.clone(),
        database_path: database.clone(),
        database_mode: DatabaseMode::Create,
    };
    let daemon = start(create_config);

    // A client can abort while the serialized daemon is executing its request. Refusing the
    // response before terminating the frame makes the server-side write fail deterministically.
    // That connection failure must not take down the listener or the healthy index.
    let mut abandoned = connect_bounded(&socket);
    let abandoned_request = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": "abandoned-health",
        "deadlineUnixMs": DEADLINE,
        "operation": { "type": "health" },
    });
    abandoned
        .write_all(
            serde_json::to_string(&abandoned_request)
                .expect("serialize abandoned request")
                .as_bytes(),
        )
        .expect("write abandoned request body");
    abandoned
        .shutdown(Shutdown::Read)
        .expect("refuse abandoned response");
    abandoned
        .write_all(b"\n")
        .expect("finish abandoned request frame");
    drop(abandoned);

    let stream = connect_bounded(&socket);
    let socket_metadata = fs::symlink_metadata(&socket).expect("socket metadata");
    assert!(socket_metadata.file_type().is_socket());
    assert_eq!(socket_metadata.mode() & 0o777, 0o600);
    let parent_metadata = fs::metadata(socket.parent().expect("socket parent")).expect("parent");
    assert_eq!(parent_metadata.mode() & 0o077, 0);
    let mut reader = BufReader::new(stream);

    let health = call(&mut reader, "health-1", json!({ "type": "health" }));
    assert_eq!(health["ok"], true);
    assert_eq!(health["response"]["generation"], "0");
    assert_eq!(
        health["response"]["capabilities"]["activeSqliteInterrupt"],
        false
    );

    let invalid = call(
        &mut reader,
        "invalid-conversion",
        json!({
            "type": "applyBatch",
            "version": "mutation-batch-v1",
            "batch": {
                "idempotencyKey": "invalid-generated",
                "payloadFingerprint": "invalid-generated-payload",
                "sourceWatermark": "01",
                "documents": [{
                    "sessionId": "generated-session",
                    "seq": "0",
                    "eventTimeUnixMs": 1000,
                    "eventType": "message/generated",
                    "surface": "conversation",
                    "workspaceId": "workspace-generated",
                    "scopeTokens": ["scopegenerated"],
                    "body": "unused generated body",
                    "fingerprint": "generated-fingerprint-invalid",
                    "sourceRevision": "generated-revision-invalid"
                }]
            }
        }),
    );
    assert_eq!(invalid["ok"], false);
    assert_eq!(invalid["error"]["code"], "invalid_request");

    let applied = call(
        &mut reader,
        "apply-1",
        json!({
            "type": "applyBatch",
            "version": "mutation-batch-v1",
            "batch": {
                "idempotencyKey": "generated-batch-1",
                "payloadFingerprint": "generated-payload-1",
                "sourceWatermark": "1",
                "documents": [{
                    "sessionId": "generated-session",
                    "seq": "0",
                    "eventTimeUnixMs": 1000,
                    "eventType": "message/generated",
                    "surface": "conversation",
                    "workspaceId": "workspace-generated",
                    "scopeTokens": ["scopegenerated"],
                    "body": "amber telescope cobalt orchard velvet compass silver meadow juniper lantern",
                    "fingerprint": "generated-fingerprint-1",
                    "sourceRevision": "generated-revision-1"
                }]
            }
        }),
    );
    assert_eq!(applied["ok"], true, "apply response: {applied}");
    assert_eq!(applied["response"]["generation"], "1");
    assert_eq!(applied["response"]["insertedDocuments"], 1);

    // Keep the ingest connection open while an independently accepted client reads.
    let mut search_reader = BufReader::new(connect_bounded(&socket));
    let source_state = call(
        &mut search_reader,
        "source-state-1",
        json!({
            "type": "sourceState",
            "version": "source-state-v1",
            "sessionIds": ["missing-generated", "generated-session"]
        }),
    );
    assert_eq!(
        source_state["ok"], true,
        "sourceState response: {source_state}"
    );
    assert_eq!(source_state["response"]["generation"], "1");
    assert_eq!(source_state["response"]["sourceWatermark"], "1");
    assert_eq!(
        source_state["response"]["sessions"][0]["sessionId"],
        "generated-session"
    );
    assert_eq!(source_state["response"]["sessions"][0]["nextSeq"], "1");
    assert_eq!(
        source_state["response"]["sessions"][0]["workspaceId"],
        "workspace-generated"
    );
    assert_eq!(
        source_state["response"]["sessions"][0]["headerRevision"],
        "generated-revision-1"
    );

    let search = call(&mut search_reader, "search-1", search_operation());
    assert_eq!(search["ok"], true, "search response: {search}");
    assert_eq!(search["response"]["snapshot"]["generation"], "1");
    assert_eq!(
        search["response"]["sources"].as_array().map(Vec::len),
        Some(5)
    );
    assert_eq!(
        search["response"]["fused"][0]["sessionId"],
        "generated-session"
    );
    assert_eq!(
        search["response"]["fused"][0]["contributions"]
            .as_array()
            .map(Vec::len),
        Some(5)
    );
    assert!(search["response"]["fused"][0]["contributions"][0]["documentKey"].is_string());
    drop(search_reader);
    shutdown(&mut reader);
    drop(reader);
    daemon
        .join()
        .expect("join create daemon")
        .expect("create daemon exit");
    assert!(!socket.exists(), "owned socket is removed on shutdown");

    let open_config = ServerConfig {
        socket_path: socket.clone(),
        database_path: database.clone(),
        database_mode: DatabaseMode::Open,
    };
    let daemon = start(open_config);
    let mut reader = BufReader::new(connect_bounded(&socket));
    let health = call(&mut reader, "health-2", json!({ "type": "health" }));
    assert_eq!(health["response"]["generation"], "1");
    let persisted_state = call(
        &mut reader,
        "source-state-2",
        json!({
            "type": "sourceState",
            "version": "source-state-v1",
            "sessionIds": ["generated-session"]
        }),
    );
    assert_eq!(persisted_state["response"]["sessions"][0]["nextSeq"], "1");
    let persisted = call(&mut reader, "search-2", search_operation());
    assert_eq!(
        persisted["response"]["fused"][0]["sessionId"],
        "generated-session"
    );
    shutdown(&mut reader);
    drop(reader);
    daemon
        .join()
        .expect("join open daemon")
        .expect("open daemon exit");

    let unsafe_target = root.path().join("unsafe-target");
    let untouched = b"generated regular file, not a socket\n";
    fs::write(&unsafe_target, untouched).expect("write unsafe target fixture");
    let should_not_exist = root.path().join("must-not-be-created.db");
    let error = run(&ServerConfig {
        socket_path: unsafe_target.clone(),
        database_path: should_not_exist.clone(),
        database_mode: DatabaseMode::Create,
    })
    .expect_err("pre-existing target must be refused");
    assert!(error.to_string().contains("pre-existing socket target"));
    assert_eq!(
        fs::read(&unsafe_target).expect("unsafe target retained"),
        untouched
    );
    assert!(!should_not_exist.exists());
}
