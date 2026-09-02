use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use qq_session_index_core::view_platform::{
    VIEW_RESPONSE_VERSION_V1, ViewAuthorityV1, ViewCatalog, ViewError, ViewFreshnessV1,
    ViewIdentityV1, ViewLifecycleV1, ViewMutationV1, ViewQueryV1, ViewSourceCheckpointV1,
    ViewStateV1,
};
use serde_json::{Value, json};
use tempfile::TempDir;

const TOKEN_A: &str = "waaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: &str = "wbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn catalog() -> (TempDir, PathBuf, ViewCatalog) {
    let root = tempfile::tempdir().expect("temporary view root");
    let legacy = root.path().join("legacy.db");
    let catalog = ViewCatalog::create(&legacy).expect("create view catalog");
    (root, legacy, catalog)
}

fn identity(id: &str) -> ViewIdentityV1 {
    ViewIdentityV1 {
        id: id.to_owned(),
        version: 1,
    }
}

fn source(identity: &str, cursor: u64, fence: &str, lag_ms: u64) -> ViewSourceCheckpointV1 {
    ViewSourceCheckpointV1 {
        source_identity: identity.to_owned(),
        durable_revision: format!("revision-{cursor}"),
        next_cursor: cursor,
        source_fence: fence.to_owned(),
        lag_ms,
    }
}

fn conversation_row(session: &str, seq: u64, body: &str, token: &str, surface: &str) -> Value {
    json!({
        "rowKey": format!("{session}:{seq}"),
        "sessionId": session,
        "seq": seq,
        "eventTimeUnixMs": 1_000 + i64::try_from(seq).expect("small seq"),
        "eventType": "message/generated",
        "surface": surface,
        "workspaceScopeToken": token,
        "body": body,
        "fingerprint": format!("fingerprint-{session}-{seq}"),
        "sessionTitle": format!("title {session}"),
        "sessionUpdatedAtUnixMs": 2_000,
    })
}

fn conversation_query(token: &str, max_lag_ms: u64) -> ViewQueryV1 {
    ViewQueryV1 {
        view: identity("qq.session.conversation"),
        access: "literal-session-search".to_owned(),
        params: json!({
            "literals": ["amber telescope"],
            "limit": 10,
            "eventTypes": ["message/generated"],
            "surfaces": ["current"]
        }),
        authority: ViewAuthorityV1 {
            kind: "workspace-token-set/v1".to_owned(),
            scope_tokens: vec![token.to_owned()],
        },
        freshness: ViewFreshnessV1 {
            mode: "caught-up".to_owned(),
            max_lag_ms,
        },
    }
}

fn sessions(response: &qq_session_index_core::view_platform::ViewQueryResponseV1) -> Vec<String> {
    response.result["sessions"]
        .as_array()
        .expect("session results")
        .iter()
        .map(|value| value["sessionId"].as_str().expect("session id").to_owned())
        .collect()
}

#[test]
fn conversation_view_is_transactional_authorized_fresh_and_reopenable() {
    let (_root, legacy, catalog) = catalog();
    let descriptions = catalog.describe().expect("describe initial views");
    assert_eq!(descriptions.len(), 2);
    assert!(
        descriptions
            .iter()
            .all(|description| description.state == ViewStateV1::Building)
    );
    assert!(
        descriptions
            .iter()
            .any(|description| !description.manifest.test_only)
    );
    assert!(
        descriptions
            .iter()
            .any(|description| description.manifest.test_only)
    );

    assert!(matches!(
        catalog.query(&conversation_query(TOKEN_A, 100)),
        Err(ViewError::ViewBuilding { .. })
    ));

    let replace_a = ViewMutationV1::ReplacePartition {
        view: identity("qq.session.conversation"),
        partition_key: "session-a".to_owned(),
        source: source("lifecycle-a", 1, "fence-1", 50),
        rows: vec![conversation_row(
            "session-a",
            0,
            "amber telescope generated",
            TOKEN_A,
            "current",
        )],
    };
    let receipt = catalog
        .apply_mutation(&replace_a)
        .expect("replace partition a");
    assert_eq!(receipt.version, VIEW_RESPONSE_VERSION_V1);
    assert_eq!(receipt.snapshot.generation, 1);
    assert_eq!(receipt.next_cursor, Some(1));
    assert_eq!(receipt.telemetry.operation, "replace-partition");
    assert_eq!(receipt.telemetry.outcome, "ok");
    assert_eq!(receipt.telemetry.counts["affectedRows"], 1);

    catalog
        .apply_mutation(&ViewMutationV1::ReplacePartition {
            view: identity("qq.session.conversation"),
            partition_key: "session-b".to_owned(),
            source: source("lifecycle-b", 1, "fence-2", 25),
            rows: vec![conversation_row(
                "session-b",
                0,
                "amber telescope secret",
                TOKEN_B,
                "current",
            )],
        })
        .expect("replace partition b");
    catalog
        .apply_lifecycle(&ViewLifecycleV1::Activate {
            view: identity("qq.session.conversation"),
            source_fence: "fence-live".to_owned(),
            lag_ms: 25,
        })
        .expect("activate conversation view");

    let cancelled = Arc::new(AtomicBool::new(true));
    assert!(matches!(
        catalog.query_controlled(&conversation_query(TOKEN_A, 100), cancelled, u64::MAX),
        Err(ViewError::Interrupted)
    ));
    assert!(matches!(
        catalog.query_controlled(
            &conversation_query(TOKEN_A, 100),
            Arc::new(AtomicBool::new(false)),
            1,
        ),
        Err(ViewError::Interrupted)
    ));

    let authorized = catalog
        .query(&conversation_query(TOKEN_A, 100))
        .expect("authorized query");
    assert_eq!(sessions(&authorized), ["session-a"]);
    assert_eq!(authorized.snapshot.source_fence, "fence-live");
    assert_eq!(authorized.telemetry.operation, "execute");
    assert_eq!(authorized.telemetry.counts["literals"], 1);
    assert_eq!(authorized.telemetry.counts["results"], 1);
    assert!(
        authorized
            .telemetry
            .phases_micros
            .contains_key("indexedPlan")
    );
    assert!(
        !serde_json::to_string(&authorized.telemetry)
            .expect("telemetry json")
            .contains("amber")
    );
    assert!(matches!(
        catalog.query(&conversation_query(TOKEN_A, 10)),
        Err(ViewError::FreshnessUnavailable { .. })
    ));

    // A behind cursor applies only its declared upsert/delete delta and updates
    // an older row (surface repair) atomically with the durable checkpoint.
    catalog
        .apply_mutation(&ViewMutationV1::ApplyDelta {
            view: identity("qq.session.conversation"),
            partition_key: "session-a".to_owned(),
            expected_cursor: 1,
            source: source("lifecycle-a", 2, "fence-3", 5),
            upserts: vec![conversation_row(
                "session-a",
                0,
                "amber telescope repaired",
                TOKEN_A,
                "shadowed",
            )],
            deletes: vec![],
        })
        .expect("surface repair delta");
    assert!(
        sessions(
            &catalog
                .query(&conversation_query(TOKEN_A, 100))
                .expect("filtered repaired query")
        )
        .is_empty()
    );

    assert!(matches!(
        catalog.apply_mutation(&ViewMutationV1::ApplyDelta {
            view: identity("qq.session.conversation"),
            partition_key: "session-a".to_owned(),
            expected_cursor: 1,
            source: source("lifecycle-a", 3, "fence-bad", 0),
            upserts: vec![],
            deletes: vec![],
        }),
        Err(ViewError::CursorConflict {
            expected: 1,
            actual: 2
        })
    ));
    assert!(matches!(
        catalog.apply_mutation(&ViewMutationV1::ApplyDelta {
            view: identity("qq.session.conversation"),
            partition_key: "session-a".to_owned(),
            expected_cursor: 2,
            source: source("other-lifecycle", 3, "fence-bad", 0),
            upserts: vec![],
            deletes: vec![],
        }),
        Err(ViewError::SourceIdentityConflict)
    ));

    drop(catalog);
    let reopened = ViewCatalog::open_or_create(&legacy).expect("reopen derived views");
    let state = reopened.describe().expect("describe reopened");
    let conversation = state
        .iter()
        .find(|description| description.manifest.id == "qq.session.conversation")
        .expect("conversation description");
    assert_eq!(conversation.state, ViewStateV1::Ready);
    assert_eq!(conversation.snapshot.generation, 4);

    reopened
        .apply_mutation(&ViewMutationV1::DeletePartition {
            view: identity("qq.session.conversation"),
            partition_key: "session-a".to_owned(),
            expected_cursor: 2,
            source_identity: "lifecycle-a".to_owned(),
            source_fence: "fence-4".to_owned(),
            lag_ms: 0,
        })
        .expect("delete partition");
    let mut shadow_query = conversation_query(TOKEN_A, 100);
    shadow_query.params["surfaces"] = json!(["shadowed"]);
    assert!(sessions(&reopened.query(&shadow_query).expect("query after delete")).is_empty());
}

#[test]
fn cross_partition_row_key_collisions_rollback_rows_and_checkpoints_for_each_view() {
    let (_root, _legacy, catalog) = catalog();

    let conversation = identity("qq.session.conversation");
    let mut conversation_a =
        conversation_row("session-a", 0, "amber telescope alpha", TOKEN_A, "current");
    conversation_a["rowKey"] = json!("shared-conversation-row");
    catalog
        .apply_mutation(&ViewMutationV1::ReplacePartition {
            view: conversation.clone(),
            partition_key: "session-a".to_owned(),
            source: source("conversation-a", 1, "conversation-fence-a", 0),
            rows: vec![conversation_a],
        })
        .expect("seed conversation partition a");
    catalog
        .apply_mutation(&ViewMutationV1::ReplacePartition {
            view: conversation.clone(),
            partition_key: "session-b".to_owned(),
            source: source("conversation-b", 1, "conversation-fence-b", 0),
            rows: vec![conversation_row(
                "session-b",
                0,
                "amber telescope beta",
                TOKEN_B,
                "current",
            )],
        })
        .expect("seed conversation partition b");
    catalog
        .apply_lifecycle(&ViewLifecycleV1::Activate {
            view: conversation.clone(),
            source_fence: "conversation-live".to_owned(),
            lag_ms: 0,
        })
        .expect("activate conversation view");
    let conversation_keys = vec!["session-a".to_owned(), "session-b".to_owned()];
    let conversation_before = catalog
        .partition_states(&conversation, &conversation_keys)
        .expect("conversation state before conflict");
    let mut colliding_conversation = conversation_row(
        "session-b",
        1,
        "replacement must roll back",
        TOKEN_B,
        "current",
    );
    colliding_conversation["rowKey"] = json!("shared-conversation-row");
    assert!(matches!(
        catalog.apply_mutation(&ViewMutationV1::ApplyDelta {
            view: conversation.clone(),
            partition_key: "session-b".to_owned(),
            expected_cursor: 1,
            source: source("conversation-b", 2, "conversation-conflict", 0),
            upserts: vec![colliding_conversation],
            deletes: vec!["session-b:0".to_owned()],
        }),
        Err(ViewError::InvalidMutation(message))
            if message.contains("row key conflicts with another partition")
    ));
    assert_eq!(
        catalog
            .partition_states(&conversation, &conversation_keys)
            .expect("conversation state after conflict"),
        conversation_before,
        "failed delta must preserve all conversation checkpoints and generation",
    );
    assert_eq!(
        sessions(
            &catalog
                .query(&conversation_query(TOKEN_A, 0))
                .expect("query conversation partition a after rollback")
        ),
        ["session-a"],
    );
    assert_eq!(
        sessions(
            &catalog
                .query(&conversation_query(TOKEN_B, 0))
                .expect("query conversation partition b after rollback")
        ),
        ["session-b"],
        "delete preceding the colliding upsert must be rolled back",
    );

    let exact = identity("qq.test.exact-range");
    catalog
        .apply_mutation(&ViewMutationV1::ReplacePartition {
            view: exact.clone(),
            partition_key: "bucket-a".to_owned(),
            source: source("exact-a", 1, "exact-fence-a", 0),
            rows: vec![json!({
                "rowKey":"shared-exact-row", "exactKey":"status", "ordinal":1,
                "workspaceScopeToken":TOKEN_A, "value":"alpha"
            })],
        })
        .expect("seed exact partition a");
    catalog
        .apply_mutation(&ViewMutationV1::ReplacePartition {
            view: exact.clone(),
            partition_key: "bucket-b".to_owned(),
            source: source("exact-b", 1, "exact-fence-b", 0),
            rows: vec![json!({
                "rowKey":"exact-row-b", "exactKey":"status", "ordinal":2,
                "workspaceScopeToken":TOKEN_B, "value":"beta"
            })],
        })
        .expect("seed exact partition b");
    catalog
        .apply_lifecycle(&ViewLifecycleV1::Activate {
            view: exact.clone(),
            source_fence: "exact-live".to_owned(),
            lag_ms: 0,
        })
        .expect("activate exact view");
    let exact_keys = vec!["bucket-a".to_owned(), "bucket-b".to_owned()];
    let exact_before = catalog
        .partition_states(&exact, &exact_keys)
        .expect("exact state before conflict");
    assert!(matches!(
        catalog.apply_mutation(&ViewMutationV1::ApplyDelta {
            view: exact.clone(),
            partition_key: "bucket-b".to_owned(),
            expected_cursor: 1,
            source: source("exact-b", 2, "exact-conflict", 0),
            upserts: vec![json!({
                "rowKey":"shared-exact-row", "exactKey":"status", "ordinal":3,
                "workspaceScopeToken":TOKEN_B, "value":"must-not-move"
            })],
            deletes: vec!["exact-row-b".to_owned()],
        }),
        Err(ViewError::InvalidMutation(message))
            if message.contains("row key conflicts with another partition")
    ));
    assert_eq!(
        catalog
            .partition_states(&exact, &exact_keys)
            .expect("exact state after conflict"),
        exact_before,
        "failed delta must preserve all exact-view checkpoints and generation",
    );
    let exact_query = |token: &str| ViewQueryV1 {
        view: exact.clone(),
        access: "exact-range".to_owned(),
        params: json!({"exactKey":"status", "minimum":0, "maximum":10, "limit":10}),
        authority: ViewAuthorityV1 {
            kind: "workspace-token-set/v1".to_owned(),
            scope_tokens: vec![token.to_owned()],
        },
        freshness: ViewFreshnessV1 {
            mode: "caught-up".to_owned(),
            max_lag_ms: 0,
        },
    };
    assert_eq!(
        catalog
            .query(&exact_query(TOKEN_A))
            .expect("query exact partition a after rollback")
            .result["rows"][0]["rowKey"],
        "shared-exact-row",
    );
    assert_eq!(
        catalog
            .query(&exact_query(TOKEN_B))
            .expect("query exact partition b after rollback")
            .result["rows"][0]["rowKey"],
        "exact-row-b",
        "delete preceding the colliding exact upsert must be rolled back",
    );
}

#[test]
fn compiled_views_dispatch_to_independent_databases_and_fail_in_isolation() {
    let (_root, _legacy, catalog) = catalog();
    let exact = identity("qq.test.exact-range");
    catalog.apply_mutation(&ViewMutationV1::ReplacePartition {
        view: exact.clone(), partition_key: "bucket-a".to_owned(), source: source("exact-a", 2, "exact-fence", 0),
        rows: vec![
            json!({"rowKey":"row-a", "exactKey":"status", "ordinal":5, "workspaceScopeToken":TOKEN_A, "value":"five"}),
            json!({"rowKey":"row-b", "exactKey":"status", "ordinal":9, "workspaceScopeToken":TOKEN_B, "value":"nine"}),
        ],
    }).expect("replace exact partition");
    catalog
        .apply_lifecycle(&ViewLifecycleV1::Activate {
            view: exact.clone(),
            source_fence: "exact-live".to_owned(),
            lag_ms: 0,
        })
        .expect("activate exact view");
    let response = catalog
        .query(&ViewQueryV1 {
            view: exact.clone(),
            access: "exact-range".to_owned(),
            params: json!({"exactKey":"status", "minimum":0, "maximum":10, "limit":10}),
            authority: ViewAuthorityV1 {
                kind: "workspace-token-set/v1".to_owned(),
                scope_tokens: vec![TOKEN_A.to_owned()],
            },
            freshness: ViewFreshnessV1 {
                mode: "caught-up".to_owned(),
                max_lag_ms: 0,
            },
        })
        .expect("exact range query");
    assert_eq!(response.result["rows"].as_array().expect("rows").len(), 1);
    assert_eq!(response.result["rows"][0]["rowKey"], "row-a");

    catalog
        .apply_lifecycle(&ViewLifecycleV1::MarkFailed {
            view: exact.clone(),
            source_fence: "exact-failed".to_owned(),
            lag_ms: 0,
        })
        .expect("mark exact failed");
    assert!(matches!(
        catalog.query(&ViewQueryV1 {
            view: exact,
            access: "exact-range".to_owned(),
            params: json!({"exactKey":"status", "minimum":0, "maximum":10, "limit":10}),
            authority: ViewAuthorityV1 {
                kind: "workspace-token-set/v1".to_owned(),
                scope_tokens: vec![TOKEN_A.to_owned()]
            },
            freshness: ViewFreshnessV1 {
                mode: "caught-up".to_owned(),
                max_lag_ms: 0
            },
        }),
        Err(ViewError::ViewFailed { .. })
    ));

    // The unrelated conversation DB remains building rather than inheriting the
    // second view's failure state.
    assert!(matches!(
        catalog.query(&conversation_query(TOKEN_A, 100)),
        Err(ViewError::ViewBuilding { .. })
    ));
    assert!(matches!(
        catalog.query(&ViewQueryV1 {
            view: ViewIdentityV1 {
                id: "unknown.view".to_owned(),
                version: 7
            },
            access: "anything".to_owned(),
            params: json!({}),
            authority: ViewAuthorityV1 {
                kind: "workspace-token-set/v1".to_owned(),
                scope_tokens: vec![TOKEN_A.to_owned()]
            },
            freshness: ViewFreshnessV1 {
                mode: "caught-up".to_owned(),
                max_lag_ms: 0
            },
        }),
        Err(ViewError::UnsupportedView { .. })
    ));
}
