use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use qq_session_index_core::view_platform::{
    ViewAuthorityV1, ViewCatalog, ViewError, ViewFreshnessV1, ViewIdentityV1, ViewLifecycleV1,
    ViewMutationV1, ViewQueryV1, ViewSourceCheckpointV1,
};
use serde_json::json;

const DOCUMENTS: usize = 16_000;
const SESSIONS: usize = 160;
const ITERATIONS: usize = 20;
const TOKEN: &str = "waaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TERMS: [&str; 5] = [
    "amber telescope",
    "cobalt orchard",
    "velvet compass",
    "silver meadow",
    "juniper lantern",
];

fn identity() -> ViewIdentityV1 {
    ViewIdentityV1 {
        id: "qq.session.conversation".to_owned(),
        version: 1,
    }
}

fn query(literals: &[&str]) -> ViewQueryV1 {
    ViewQueryV1 {
        view: identity(),
        access: "literal-session-search".to_owned(),
        params: json!({
            "literals": literals,
            "limit": 100,
            "eventTypes": ["message/generated"],
            "surfaces": ["current"]
        }),
        authority: ViewAuthorityV1 {
            kind: "workspace-token-set/v1".to_owned(),
            scope_tokens: vec![TOKEN.to_owned()],
        },
        freshness: ViewFreshnessV1 {
            mode: "caught-up".to_owned(),
            max_lag_ms: 1_000,
        },
    }
}

fn percentile(samples: &mut [Duration], percentile: usize) -> f64 {
    samples.sort_unstable();
    let rank = ((samples.len() * percentile).div_ceil(100)).max(1) - 1;
    samples[rank].as_secs_f64() * 1_000.0
}

#[test]
fn generated_named_view_latency_observations_meet_core_gates() {
    let root = tempfile::tempdir().expect("temporary generated view benchmark");
    let legacy = root.path().join("legacy.db");
    let catalog = ViewCatalog::create(&legacy).expect("create generated view catalog");
    let rows_per_session = DOCUMENTS / SESSIONS;
    let build_started = Instant::now();
    for session in 0..SESSIONS {
        let session_id = format!("generated-session-{session:03}");
        let rows = (0..rows_per_session)
            .map(|seq| {
                let ordinal = session * rows_per_session + seq;
                json!({
                    "rowKey": format!("{session_id}:{seq}"),
                    "sessionId": session_id,
                    "seq": seq,
                    "eventTimeUnixMs": 1_700_000_000_000_i64 + i64::try_from(ordinal).expect("small ordinal"),
                    "eventType": "message/generated",
                    "surface": "current",
                    "workspaceScopeToken": TOKEN,
                    "body": format!("{} generated bounded document {ordinal}", TERMS.join(" ")),
                    "fingerprint": format!("fingerprint-{ordinal}"),
                    "sessionTitle": format!("Generated session {session}"),
                    "sessionUpdatedAtUnixMs": 1_700_100_000_000_i64,
                })
            })
            .collect();
        catalog
            .apply_mutation(&ViewMutationV1::ReplacePartition {
                view: identity(),
                partition_key: session_id.clone(),
                source: ViewSourceCheckpointV1 {
                    source_identity: format!("lifecycle-{session}"),
                    durable_revision: "revision-1".to_owned(),
                    next_cursor: u64::try_from(rows_per_session).expect("small cursor"),
                    source_fence: format!("build-{session}"),
                    lag_ms: 0,
                },
                rows,
            })
            .expect("materialize generated partition");
    }
    catalog
        .apply_lifecycle(&ViewLifecycleV1::Activate {
            view: identity(),
            source_fence: "generated-live".to_owned(),
            lag_ms: 0,
        })
        .expect("activate generated view");
    let build_ms = build_started.elapsed().as_secs_f64() * 1_000.0;

    // Warm both plans before collecting repeated observations.
    catalog
        .query(&query(&TERMS[..1]))
        .expect("warm one literal");
    catalog.query(&query(&TERMS)).expect("warm five literals");
    let mut one = Vec::with_capacity(ITERATIONS);
    let mut five = Vec::with_capacity(ITERATIONS);
    for _ in 0..ITERATIONS {
        let started = Instant::now();
        let response = catalog
            .query(&query(&TERMS[..1]))
            .expect("one-literal query");
        one.push(started.elapsed());
        assert!(
            !response.result["sessions"]
                .as_array()
                .expect("results")
                .is_empty()
        );

        let started = Instant::now();
        catalog.query(&query(&TERMS)).expect("five-literal query");
        five.push(started.elapsed());
    }
    let one_p50 = percentile(&mut one.clone(), 50);
    let one_p95 = percentile(&mut one, 95);
    let five_p50 = percentile(&mut five.clone(), 50);
    let five_p95 = percentile(&mut five, 95);

    drop(catalog);
    let reopen_started = Instant::now();
    let reopened = ViewCatalog::open_or_create(&legacy).expect("reopen generated view catalog");
    let reopen_ms = reopen_started.elapsed().as_secs_f64() * 1_000.0;

    let visibility_started = Instant::now();
    reopened
        .apply_mutation(&ViewMutationV1::ApplyDelta {
            view: identity(),
            partition_key: "generated-session-000".to_owned(),
            expected_cursor: u64::try_from(rows_per_session).expect("small cursor"),
            source: ViewSourceCheckpointV1 {
                source_identity: "lifecycle-0".to_owned(),
                durable_revision: "revision-2".to_owned(),
                next_cursor: u64::try_from(rows_per_session + 1).expect("small cursor"),
                source_fence: "generated-live-append".to_owned(),
                lag_ms: 0,
            },
            upserts: vec![json!({
                "rowKey": format!("generated-session-000:{rows_per_session}"),
                "sessionId": "generated-session-000",
                "seq": rows_per_session,
                "eventTimeUnixMs": 1_700_200_000_000_i64,
                "eventType": "message/generated",
                "surface": "current",
                "workspaceScopeToken": TOKEN,
                "body": "fresh visibility marker",
                "fingerprint": "fresh-fingerprint",
                "sessionTitle": "Generated session 0",
                "sessionUpdatedAtUnixMs": 1_700_200_000_000_i64,
            })],
            deletes: vec![],
        })
        .expect("generated live append");
    let fresh = reopened
        .query(&query(&["fresh visibility"]))
        .expect("fresh query");
    assert_eq!(
        fresh.result["sessions"][0]["sessionId"],
        "generated-session-000"
    );
    let visibility_ms = visibility_started.elapsed().as_secs_f64() * 1_000.0;

    let cancellation_started = Instant::now();
    assert!(matches!(
        reopened.query_controlled(&query(&TERMS), Arc::new(AtomicBool::new(true)), u64::MAX),
        Err(ViewError::Interrupted)
    ));
    let cancellation_ms = cancellation_started.elapsed().as_secs_f64() * 1_000.0;

    eprintln!(
        "{}",
        json!({
            "schema": "qq-index-view-v2-generated-core-observation-v1",
            "synthetic": true,
            "documents": DOCUMENTS,
            "sessions": SESSIONS,
            "iterations": ITERATIONS,
            "buildMs": build_ms,
            "warmOneLiteral": { "p50Ms": one_p50, "p95Ms": one_p95 },
            "warmFiveLiteral": { "p50Ms": five_p50, "p95Ms": five_p95 },
            "existingViewReopenMs": reopen_ms,
            "liveVisibilityMs": visibility_ms,
            "preCancelledTerminalMs": cancellation_ms,
            "scope": "core-only-not-production-qualification"
        })
    );

    assert!(
        one_p50 < 100.0 && one_p95 < 300.0,
        "one-literal core observation exceeded gate"
    );
    assert!(
        five_p50 < 250.0 && five_p95 < 750.0,
        "five-literal core observation exceeded gate"
    );
    assert!(reopen_ms < 2_000.0, "existing-view reopen exceeded gate");
    assert!(
        visibility_ms < 1_000.0,
        "generated live visibility exceeded gate"
    );
    assert!(
        cancellation_ms < 100.0,
        "pre-cancelled terminal exceeded gate"
    );
}
