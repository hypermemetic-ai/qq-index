use std::fs;
use std::path::{Path, PathBuf};

use qq_session_index_core::{
    APPLICATION_ID, IndexError, MutationBatch, ProjectedDocument, RAW_POSTING_SCAN_BUDGET_V1,
    RRF_K_V1, SCHEMA_VERSION, SearchBatchV1, SearchFiltersV1, SessionIndex, SessionSeqBoundV1,
    SourceTruncationReasonV1,
};
use rusqlite::Connection;
use tempfile::TempDir;

fn new_index() -> (TempDir, PathBuf, SessionIndex) {
    let root = tempfile::tempdir().expect("temporary directory");
    let path = root.path().join("derived-index.db");
    let index = SessionIndex::create(&path).expect("create synthetic index");
    (root, path, index)
}

fn projected(session_id: &str, seq: u64, body: &str, scope_terms: &[&str]) -> ProjectedDocument {
    ProjectedDocument {
        session_id: session_id.to_owned(),
        seq,
        event_time_unix_ms: 1_000 + i64::try_from(seq).expect("small synthetic seq"),
        event_type: "message/generated".to_owned(),
        surface: "conversation".to_owned(),
        workspace_id: "workspace-a".to_owned(),
        scope_tokens: scope_terms.iter().map(|term| (*term).to_owned()).collect(),
        body: body.to_owned(),
        fingerprint: format!("fingerprint-{session_id}-{seq}"),
        source_revision: format!("revision-{session_id}-{seq}"),
    }
}

fn mutation(key: &str, watermark: u64, documents: Vec<ProjectedDocument>) -> MutationBatch {
    MutationBatch {
        idempotency_key: key.to_owned(),
        payload_fingerprint: format!("payload-{key}"),
        source_watermark: watermark,
        documents,
    }
}

fn filters(scope_terms: &[&str]) -> SearchFiltersV1 {
    SearchFiltersV1 {
        authorized_scope_terms: scope_terms.iter().map(|term| (*term).to_owned()).collect(),
        ..SearchFiltersV1::default()
    }
}

fn request(literals: &[&str], scope_terms: &[&str]) -> SearchBatchV1 {
    SearchBatchV1 {
        literals: literals
            .iter()
            .map(|literal| (*literal).to_owned())
            .collect(),
        per_source_depth: 10,
        final_limit: 10,
        filters: filters(scope_terms),
        minimum_source_watermark: None,
    }
}

fn only_session_ids(index: &SessionIndex, request: &SearchBatchV1) -> Vec<String> {
    index
        .search_batch_v1(request)
        .expect("synthetic search")
        .sources[0]
        .ranked
        .iter()
        .map(|hit| hit.session_id.clone())
        .collect()
}

fn create_spoofed_identity(path: &Path) {
    let connection = Connection::open(path).expect("create spoof database");
    connection
        .execute("CREATE TABLE unrelated(value TEXT)", [])
        .expect("create unrelated table");
    connection
        .pragma_update(None, "application_id", APPLICATION_ID)
        .expect("spoof application id");
    connection
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .expect("spoof schema version");
}

#[test]
fn lifecycle_is_versioned_rejects_foreign_shapes_and_reopens_without_source_work() {
    let (_root, path, index) = new_index();
    let initial = mutation(
        "lifecycle",
        7,
        vec![projected("session-a", 0, "synthetic orbit", &["scopea"])],
    );
    index.apply_batch(&initial).expect("seed index");
    let metadata_before = index.metadata().expect("metadata before reopen");
    let count_before = index.document_count().expect("count before reopen");
    drop(index);

    let reopened = SessionIndex::open(&path).expect("reopen valid index");
    assert_eq!(reopened.metadata().expect("metadata"), metadata_before);
    assert_eq!(reopened.document_count().expect("count"), count_before);
    assert_eq!(
        only_session_ids(&reopened, &request(&["synthetic orbit"], &["scopea"])),
        ["session-a"]
    );
    drop(reopened);

    let settings = Connection::open(&path).expect("inspect generated index metadata");
    let application_id: i32 = settings
        .query_row("PRAGMA application_id", [], |row| row.get(0))
        .expect("application id");
    let user_version: i32 = settings
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("user version");
    let journal_mode: String = settings
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("journal mode");
    assert_eq!(application_id, APPLICATION_ID);
    assert_eq!(user_version, SCHEMA_VERSION);
    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    drop(settings);

    let existing_root = tempfile::tempdir().expect("temporary directory");
    let existing_path = existing_root.path().join("existing.db");
    fs::write(&existing_path, b"not an index").expect("write nonempty fixture");
    assert!(matches!(
        SessionIndex::create(&existing_path),
        Err(IndexError::AlreadyExists(_))
    ));
    assert!(SessionIndex::open(&existing_path).is_err());

    let foreign_root = tempfile::tempdir().expect("temporary directory");
    let foreign_path = foreign_root.path().join("foreign.db");
    let foreign = Connection::open(&foreign_path).expect("foreign database");
    foreign
        .execute("CREATE TABLE unrelated(value TEXT)", [])
        .expect("foreign table");
    drop(foreign);
    assert!(matches!(
        SessionIndex::open(&foreign_path),
        Err(IndexError::ForeignDatabase { .. })
    ));

    let spoof_root = tempfile::tempdir().expect("temporary directory");
    let spoof_path = spoof_root.path().join("spoof.db");
    create_spoofed_identity(&spoof_path);
    let spoof = Connection::open(&spoof_path).expect("inspect spoof database");
    let journal_before: String = spoof
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("spoof journal mode");
    drop(spoof);
    assert!(matches!(
        SessionIndex::open(&spoof_path),
        Err(IndexError::InvalidSchema(_))
    ));
    let spoof = Connection::open(&spoof_path).expect("reinspect spoof database");
    let journal_after: String = spoof
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .expect("spoof journal mode after rejection");
    assert_eq!(journal_after, journal_before);
    drop(spoof);

    let version_root = tempfile::tempdir().expect("temporary directory");
    let version_path = version_root.path().join("version.db");
    drop(SessionIndex::create(&version_path).expect("version index"));
    let version = Connection::open(&version_path).expect("open generated index");
    version
        .pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .expect("change version");
    drop(version);
    assert!(matches!(
        SessionIndex::open(&version_path),
        Err(IndexError::UnsupportedSchema { .. })
    ));

    let malformed_root = tempfile::tempdir().expect("temporary directory");
    let malformed_path = malformed_root.path().join("malformed.db");
    fs::write(&malformed_path, b"generated malformed sqlite bytes")
        .expect("write malformed database");
    assert!(SessionIndex::open(&malformed_path).is_err());
}

#[test]
fn schema_fingerprint_objects_and_definitions_fail_closed() {
    let (_root, path, index) = new_index();
    drop(index);
    let connection = Connection::open(&path).expect("open generated index");
    connection
        .execute(
            "UPDATE index_meta SET schema_fingerprint = 'unknown-schema' WHERE singleton = 1",
            [],
        )
        .expect("alter generated metadata");
    drop(connection);
    assert!(matches!(
        SessionIndex::open(&path),
        Err(IndexError::InvalidSchema(_))
    ));

    let (_root, path, index) = new_index();
    drop(index);
    let connection = Connection::open(&path).expect("open generated index");
    connection
        .execute("DROP TRIGGER documents_ai", [])
        .expect("remove generated trigger");
    drop(connection);
    assert!(matches!(
        SessionIndex::open(&path),
        Err(IndexError::InvalidSchema(_))
    ));

    let (_root, path, index) = new_index();
    drop(index);
    let connection = Connection::open(&path).expect("open generated index");
    connection
        .execute_batch(
            "DROP TRIGGER documents_ai;
             CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN SELECT 1; END;",
        )
        .expect("replace generated trigger with same-name no-op");
    drop(connection);
    assert!(matches!(
        SessionIndex::open(&path),
        Err(IndexError::InvalidSchema(_))
    ));

    let (_root, path, index) = new_index();
    drop(index);
    let connection = Connection::open(&path).expect("open generated index");
    connection
        .execute_batch(
            "DROP INDEX documents_metadata;
             CREATE INDEX documents_metadata ON documents(seq);",
        )
        .expect("replace generated index with wrong same-name index");
    drop(connection);
    assert!(matches!(
        SessionIndex::open(&path),
        Err(IndexError::InvalidSchema(_))
    ));
}

#[test]
fn committed_appends_are_visible_and_advance_one_snapshot() {
    let (_root, _path, index) = new_index();
    let first = index
        .apply_batch(&mutation(
            "append-1",
            10,
            vec![projected("session-a", 0, "quartz first", &["scopea"])],
        ))
        .expect("first append");
    assert_eq!(first.generation, 1);
    assert_eq!(first.source_watermark, 10);

    let first_search = index
        .search_batch_v1(&request(&["quartz first"], &["scopea"]))
        .expect("search committed first append");
    assert_eq!(first_search.snapshot.generation, 1);
    assert_eq!(first_search.snapshot.source_watermark, 10);
    let evidence = &first_search.sources[0].ranked[0].evidence;
    assert_eq!(evidence.session_id, "session-a");
    assert_eq!(evidence.seq, 0);
    assert_eq!(evidence.event_time_unix_ms, 1_000);
    assert_eq!(evidence.event_type, "message/generated");
    assert_eq!(evidence.surface, "conversation");
    assert!(evidence.document_key.starts_with("document-v1:"));

    let second = index
        .apply_batch(&mutation(
            "append-2",
            11,
            vec![projected("session-a", 1, "quartz second", &["scopea"])],
        ))
        .expect("second append");
    assert_eq!(second.generation, 2);
    assert_eq!(second.source_watermark, 11);

    let mut second_request = request(&["quartz second"], &["scopea"]);
    second_request.minimum_source_watermark = Some(11);
    let second_search = index
        .search_batch_v1(&second_request)
        .expect("search committed second append");
    assert_eq!(second_search.snapshot.generation, 2);
    assert_eq!(second_search.snapshot.source_watermark, 11);
    assert_eq!(second_search.sources[0].ranked[0].evidence.seq, 1);

    second_request.minimum_source_watermark = Some(12);
    assert!(matches!(
        index.search_batch_v1(&second_request),
        Err(IndexError::SourceWatermarkUnavailable {
            minimum: 12,
            available: 11,
            generation: 2
        })
    ));
}

#[test]
fn exact_replay_is_noop_but_conflicts_gaps_and_noncontiguous_input_roll_back() {
    let (_root, _path, index) = new_index();
    let first = mutation(
        "stable-key",
        1,
        vec![
            projected("session-a", 0, "ember zero", &["scopea"]),
            projected("session-a", 1, "ember one", &["scopea"]),
        ],
    );
    let receipt = index.apply_batch(&first).expect("first batch");
    let replay = index.apply_batch(&first).expect("exact replay");
    assert!(!receipt.batch_replayed);
    assert!(replay.batch_replayed);
    assert_eq!(replay.generation, receipt.generation);
    assert_eq!(index.document_count().expect("document count"), 2);

    let mut same_key_changed_content = first.clone();
    same_key_changed_content.documents[1].body = "changed body".to_owned();
    assert!(matches!(
        index.apply_batch(&same_key_changed_content),
        Err(IndexError::IdempotencyConflict { .. })
    ));

    let mut conflicting_duplicate = projected("session-a", 1, "changed", &["scopea"]);
    conflicting_duplicate.fingerprint = "conflicting-fingerprint".to_owned();
    assert!(matches!(
        index.apply_batch(&mutation(
            "conflicting-document",
            2,
            vec![conflicting_duplicate]
        )),
        Err(IndexError::DocumentConflict { seq: 1, .. })
    ));

    assert!(matches!(
        index.apply_batch(&mutation(
            "gap",
            2,
            vec![projected("session-a", 3, "gap", &["scopea"])]
        )),
        Err(IndexError::SequenceGap {
            expected: 2,
            actual: 3,
            ..
        })
    ));

    assert!(matches!(
        index.apply_batch(&mutation(
            "noncontiguous",
            2,
            vec![
                projected("session-b", 0, "zero", &["scopea"]),
                projected("session-b", 2, "two", &["scopea"]),
            ]
        )),
        Err(IndexError::InvalidMutation(_))
    ));
    assert_eq!(index.metadata().expect("metadata").generation, 1);
    assert_eq!(index.metadata().expect("metadata").source_watermark, 1);
    assert_eq!(index.document_count().expect("document count"), 2);
}

#[test]
fn literals_are_quoted_and_scope_isolation_precedes_candidate_materialization() {
    let (_root, _path, index) = new_index();
    index
        .apply_batch(&mutation(
            "scope-fixture",
            1,
            vec![
                projected(
                    "session-authorized",
                    0,
                    "alpha OR beta visible",
                    &["scopea"],
                ),
                projected(
                    "session-other-scope",
                    0,
                    "alpha OR beta hidden-marker",
                    &["scopeb"],
                ),
                projected("session-beta", 0, "beta alone", &["scopea"]),
            ],
        ))
        .expect("scope fixture");

    let response = index
        .search_batch_v1(&request(&["alpha OR beta"], &["scopea"]))
        .expect("quoted phrase search");
    assert_eq!(response.sources[0].raw_postings_scanned, 1);
    assert_eq!(response.sources[0].ranked.len(), 1);
    assert_eq!(
        response.sources[0].ranked[0].session_id,
        "session-authorized"
    );
    assert_eq!(response.fused.len(), 1);
    assert_eq!(response.fused[0].session_id, "session-authorized");
    assert!(response.sources[0].ranked[0].evidence.snippet.is_none());
    assert!(response.fused[0].contributions[0].snippet.is_none());

    let injected = index
        .search_batch_v1(&request(&["alpha\" OR scope_terms:scopeb"], &["scopea"]))
        .expect("syntax-like text is quoted as data");
    assert!(injected.sources[0].ranked.is_empty());
    assert!(injected.fused.is_empty());

    for syntax_only_literal in ["\"", "*", "(", "-", ":", "NEAR(", "scope_terms:scopeb"] {
        let safely_quoted = index.search_batch_v1(&request(&[syntax_only_literal], &["scopea"]));
        assert!(
            safely_quoted.is_ok(),
            "syntax-like literal {syntax_only_literal:?} must be treated as data"
        );
    }

    let multi_scope = index
        .search_batch_v1(&request(&["hidden-marker"], &["scopea", "scopeb"]))
        .expect("multiple authorized scopes");
    assert_eq!(multi_scope.sources[0].ranked.len(), 1);
    assert_eq!(
        multi_scope.sources[0].ranked[0].session_id,
        "session-other-scope"
    );

    let mut invalid_scope = request(&["alpha"], &["scope-a"]);
    assert!(matches!(
        index.search_batch_v1(&invalid_scope),
        Err(IndexError::InvalidSearch(_))
    ));
    invalid_scope.filters.authorized_scope_terms.clear();
    assert!(matches!(
        index.search_batch_v1(&invalid_scope),
        Err(IndexError::InvalidSearch(_))
    ));
}

#[test]
fn workspace_surface_session_time_and_sequence_filters_are_applied() {
    let (_root, _path, index) = new_index();
    let mut a0 = projected("session-a", 0, "nebula shared", &["scopea"]);
    a0.event_time_unix_ms = 100;
    let mut a1 = projected("session-a", 1, "nebula shared", &["scopea"]);
    a1.event_time_unix_ms = 200;
    a1.surface = "tool".to_owned();
    a1.event_type = "tool/result".to_owned();
    let mut a2 = projected("session-a", 2, "nebula shared", &["scopea"]);
    a2.event_time_unix_ms = 300;
    let mut b0 = projected("session-b", 0, "nebula shared", &["scopea"]);
    b0.event_time_unix_ms = 150;
    b0.workspace_id = "workspace-b".to_owned();
    index
        .apply_batch(&mutation("filters", 1, vec![a0, a1, a2, b0]))
        .expect("filter fixture");

    let mut workspace = request(&["nebula shared"], &["scopea"]);
    workspace.filters.workspace_ids = vec!["workspace-a".to_owned()];
    assert_eq!(only_session_ids(&index, &workspace), ["session-a"]);

    let mut surface = workspace.clone();
    surface.filters.surface_allow_list = vec!["tool".to_owned()];
    let surface_result = index.search_batch_v1(&surface).expect("surface filter");
    assert_eq!(surface_result.sources[0].ranked.len(), 1);
    assert_eq!(surface_result.sources[0].ranked[0].evidence.seq, 1);
    assert_eq!(surface_result.sources[0].ranked[0].evidence.surface, "tool");

    let mut tool_type = workspace.clone();
    tool_type.filters.event_type_allow_list = vec!["tool/result".to_owned()];
    let tool_type_result = index
        .search_batch_v1(&tool_type)
        .expect("event-type filter");
    assert_eq!(tool_type_result.sources[0].ranked.len(), 1);
    assert_eq!(tool_type_result.sources[0].ranked[0].evidence.seq, 1);
    assert_eq!(
        tool_type_result.sources[0].ranked[0].evidence.event_type,
        "tool/result"
    );

    let mut conversation_type = workspace.clone();
    conversation_type.filters.event_type_allow_list = vec!["message/generated".to_owned()];
    let conversation_result = index
        .search_batch_v1(&conversation_type)
        .expect("conversation type filter");
    assert!(
        conversation_result.sources[0]
            .ranked
            .iter()
            .all(|hit| hit.evidence.event_type == "message/generated")
    );

    let mut as_of = workspace.clone();
    as_of.filters.not_after_event_time_unix_ms = Some(150);
    let as_of_result = index.search_batch_v1(&as_of).expect("as-of filter");
    assert_eq!(as_of_result.sources[0].ranked[0].evidence.seq, 0);
    assert_eq!(
        as_of_result.sources[0].ranked[0]
            .evidence
            .event_time_unix_ms,
        100
    );

    let mut not_before = workspace.clone();
    not_before.filters.not_before_event_time_unix_ms = Some(250);
    assert_eq!(
        index
            .search_batch_v1(&not_before)
            .expect("lower time")
            .sources[0]
            .ranked[0]
            .evidence
            .seq,
        2
    );

    let mut included = request(&["nebula shared"], &["scopea"]);
    included.filters.include_session_ids = vec!["session-b".to_owned()];
    assert_eq!(only_session_ids(&index, &included), ["session-b"]);

    let mut excluded = request(&["nebula shared"], &["scopea"]);
    excluded.filters.exclude_session_ids = vec!["session-a".to_owned()];
    assert_eq!(only_session_ids(&index, &excluded), ["session-b"]);

    let mut bounded = request(&["nebula shared"], &["scopea"]);
    bounded.filters.include_session_ids = vec!["session-a".to_owned()];
    bounded.filters.session_seq_bounds = vec![SessionSeqBoundV1 {
        session_id: "session-a".to_owned(),
        not_before_seq: Some(1),
        not_after_seq: Some(1),
    }];
    assert_eq!(
        index
            .search_batch_v1(&bounded)
            .expect("sequence bound")
            .sources[0]
            .ranked[0]
            .evidence
            .seq,
        1
    );
}

#[test]
fn five_literals_share_one_snapshot_and_fuse_deterministically() {
    let (_root, _path, index) = new_index();
    let body = "amber birch cedar delta elm";
    index
        .apply_batch(&mutation(
            "five-literal",
            25,
            vec![
                projected("session-a", 0, body, &["scopea"]),
                projected("session-b", 0, body, &["scopea"]),
            ],
        ))
        .expect("five-literal fixture");

    let search = request(&["amber", "birch", "cedar", "delta", "elm"], &["scopea"]);
    let response = index.search_batch_v1(&search).expect("five-literal search");
    let repeated = index
        .search_batch_v1(&search)
        .expect("repeat deterministic search");
    assert_eq!(response, repeated);
    assert_eq!(response.snapshot.generation, 1);
    assert_eq!(response.snapshot.source_watermark, 25);
    assert_eq!(response.sources.len(), 5);
    for (ordinal, source) in response.sources.iter().enumerate() {
        assert_eq!(source.query_ordinal, ordinal);
        assert_eq!(
            source.truncation_reason,
            SourceTruncationReasonV1::Exhausted
        );
        assert!(!source.truncated);
        assert_eq!(source.raw_postings_scanned, 2);
        assert_eq!(source.ranked[0].session_id, "session-a");
        assert_eq!(source.ranked[1].session_id, "session-b");
    }

    assert_eq!(response.fused.len(), 2);
    assert_eq!(response.fused[0].rank, 1);
    assert_eq!(response.fused[0].session_id, "session-a");
    assert_eq!(response.fused[1].session_id, "session-b");
    assert_eq!(response.fused[0].contributions.len(), 5);
    assert_eq!(
        response.fused[0]
            .contributions
            .iter()
            .map(|contribution| contribution.query_ordinal)
            .collect::<Vec<_>>(),
        [0, 1, 2, 3, 4]
    );
    let expected_a = 5.0 / (f64::from(RRF_K_V1) + 1.0);
    let expected_b = 5.0 / (f64::from(RRF_K_V1) + 2.0);
    assert!((response.fused[0].rrf_score - expected_a).abs() < f64::EPSILON);
    assert!((response.fused[1].rrf_score - expected_b).abs() < f64::EPSILON);
    assert!(!response.fused_truncated);

    let mut limited_search = search;
    limited_search.final_limit = 1;
    let limited = index
        .search_batch_v1(&limited_search)
        .expect("final-limit search");
    assert_eq!(limited.fused.len(), 1);
    assert!(limited.fused_truncated);
}

#[test]
fn source_depth_and_posting_budget_truncation_are_explicit_and_bounded() {
    let (_root, _path, depth_index) = new_index();
    depth_index
        .apply_batch(&mutation(
            "depth",
            1,
            vec![
                projected("session-a", 0, "common generated", &["scopea"]),
                projected("session-b", 0, "common generated", &["scopea"]),
                projected("session-c", 0, "common generated", &["scopea"]),
            ],
        ))
        .expect("depth fixture");
    let mut depth_request = request(&["common"], &["scopea"]);
    depth_request.per_source_depth = 2;
    let depth = depth_index
        .search_batch_v1(&depth_request)
        .expect("depth-bounded search");
    assert!(depth.sources[0].truncated);
    assert_eq!(
        depth.sources[0].truncation_reason,
        SourceTruncationReasonV1::SourceDepth
    );
    assert_eq!(depth.sources[0].raw_postings_scanned, 2);
    assert_eq!(depth.sources[0].ranked.len(), 2);

    let (_root, _path, budget_index) = new_index();
    let documents = (0..=RAW_POSTING_SCAN_BUDGET_V1)
        .map(|seq| {
            projected(
                "session-common",
                u64::try_from(seq).expect("small synthetic seq"),
                "common generated",
                &["scopea"],
            )
        })
        .collect();
    budget_index
        .apply_batch(&mutation("budget", 1, documents))
        .expect("posting-budget fixture");
    let mut budget_request = request(&["common"], &["scopea"]);
    budget_request.per_source_depth = 100;
    let budget = budget_index
        .search_batch_v1(&budget_request)
        .expect("posting-budget search");
    assert!(budget.sources[0].truncated);
    assert_eq!(
        budget.sources[0].truncation_reason,
        SourceTruncationReasonV1::PostingBudget
    );
    assert_eq!(
        budget.sources[0].raw_postings_scanned,
        RAW_POSTING_SCAN_BUDGET_V1
    );
    assert_eq!(budget.sources[0].ranked.len(), 1);
    assert_eq!(budget.sources[0].ranked[0].session_id, "session-common");
}

#[test]
fn request_cardinality_lengths_and_ranges_are_strict() {
    let (_root, _path, index) = new_index();
    let invalid_requests = [
        SearchBatchV1 {
            literals: Vec::new(),
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            literals: vec!["one", "two", "three", "four", "five", "six"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            literals: vec![" ".to_owned()],
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            literals: vec!["x".repeat(501)],
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            per_source_depth: 0,
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            final_limit: 0,
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            filters: SearchFiltersV1 {
                not_before_event_time_unix_ms: Some(2),
                not_after_event_time_unix_ms: Some(1),
                ..filters(&["scopea"])
            },
            ..request(&["valid"], &["scopea"])
        },
        SearchBatchV1 {
            filters: SearchFiltersV1 {
                event_type_allow_list: (0..=32).map(|value| format!("type/{value}")).collect(),
                ..filters(&["scopea"])
            },
            ..request(&["valid"], &["scopea"])
        },
    ];
    for invalid in invalid_requests {
        assert!(matches!(
            index.search_batch_v1(&invalid),
            Err(IndexError::InvalidSearch(_))
        ));
    }
}
