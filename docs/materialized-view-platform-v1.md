# Compiled materialized-view platform V1

Status: **implemented proof slice; shadow/rollback only, not production cutover**.

## Forward target and ownership

The source target is released DSH `0.1.2-alpha.4`, tag `dsh-v0.1.2-alpha.4`, commit `4e84901e6471b79ec0338099867ebb4606d12bb5`. The adapter in `src/dsh-alpha4-view-source.mjs` uses the stock public `observeSession(id, { signal, projectionMode })` observation lease: immutable header/events/cursor, optional durable revision/projections, and explicit disposal. It does not copy or depend on qq-core's pinned rc.7 `readEventDocumentSnapshots` patch.

DSH owns source authority and change observation. qq-index owns all derived durable state, view lifecycle, authorization intersection, query planning, serving, and bounded operational telemetry. A query-time call to DSH/session persistence is a contract failure. The legacy `searchBatch` + exact DSH verifier stays available only as rollback and shadow reference oracle until parity/soak/cutover gates pass.

## `ViewModuleV1`

A view is a trusted compiled module, not a runtime DSL. Its immutable manifest declares:

- `(id, version, digest)` plus immutable physical `buildId`;
- alpha.4 source contract and independent projector `sourceStateVersion`;
- partition key, closed row schema and physical schema identity;
- maximum rows and encoded bytes per atomic partition replacement;
- authorization contract;
- named fixed accesses with result/work ceilings;
- whether the module is test-only.

The JS ABI and catalog are in `src/views/registry.mjs` and `src/views/catalog.mjs`. Manifests are canonical-JSON SHA-256 checked at load. `createConversationProjectorV1` owns the alpha.4 observation-to-row coordinate/workspace/title/revision boundary while injected canonical helpers own DSH event/surface/title folds. The matching Rust catalog/handlers are in `crates/session-index-core/src/view_platform/`. Static modules are:

| View | Access | Result/work bound | Purpose |
|---|---|---:|---|
| `qq.session.conversation@1` | `literal-session-search` | 100 results; 5 × 256 postings | First real session-history view |
| `qq.test.exact-range@1` | `exact-range` | 32 results/work units | Proves dispatch is not hard-coded to FTS or conversations |

The generic daemon layer knows framing, same-UID admission, identities, lifecycle/freshness, partition checkpoints, activation, cancellation/deadlines, and telemetry. Each Rust handler owns row parsing, tables/indexes, SQL, authorization predicate, ordering, and result shape. There is no runtime SQL/expression API.

Each immutable physical build has its own SQLite database under `<legacy-db>.views-v2/`. `buildId` is immutable physical identity; `generation` advances transactionally. Both initial modules declare at most 1,024 rows / 900 KiB per atomic partition replacement. Oversize source partitions fail the build explicitly; they are never silently truncated. Cross-view transactions/joins are deliberately unsupported.

## Closed V2 operations

All operations retain existing UDS framing, frame bounds, same-UID checks and global client admission.

- `describeViews`: manifests plus per-view state/snapshot.
- `viewPartitionState`: at most 64 unique keys; returns only source identity, revision, next cursor and generation. It never returns rows.
- `mutateView`:
  - `replacePartition(partitionKey, source, rows)`;
  - `applyDelta(partitionKey, expectedCursor, source, upserts, deletes)`;
  - `deletePartition(partitionKey, expectedCursor, sourceIdentity, fence)`.
- `setViewLifecycle`: atomic `building`, `ready`, or `failed` state/fence/lag update.
- `execute`: fixed view/access dispatch with authority and freshness.

Rows/indexes/checkpoint/fence/generation change in one immediate transaction. Cursor, source-lifecycle, or cross-partition `rowKey` conflicts reject atomically without moving rows or advancing a checkpoint. Replacement repairs retroactive surface/title/metadata changes; deletion removes a complete partition. A view initializes `building`; building/failed/stale/version/access/auth failures are typed and fail closed.

`execute` registers in the existing bounded cancellation registry and remains queued, with no interrupt handle, while it waits for its per-view connection mutex. Only the mutex owner transitions active and publishes that connection's matching SQLite interrupt handle; it clears the handle before releasing the mutex. This prevents cancellation of queued request B from interrupting active request A. View work does not consume or alter the legacy fixed reader pool's `readerCount`, `activeReaders`, or `peakActiveReaders` telemetry. A progress callback closes cancellation/deadline races during SQLite execution. Per-view connections serialize operations without coupling independent view databases.

## Query contract

Typed consumers call:

```js
qqSessionIndex.queryView({
  version: "qq-index-query/v1",
  view: { id: "qq.session.conversation", version: 1 },
  access: "literal-session-search",
  params: { literals, limit, afterUnixMs, beforeUnixMs, eventTypes, surfaces },
  authority: { kind: "workspace-set/v1", workspaceIds },
  freshness: { mode: "caught-up", maxLagMs: 1_000 },
}, { signal, deadlineUnixMs });
```

The typed module validates the closed request and result. qq-index derives and deduplicates canonical opaque workspace scope tokens internally; only `workspace-token-set/v1` reaches the daemon. The conversation handler intersects those terms inside FTS before ranking and returns materialized same-cut title/evidence. It performs no exact replay, corpus listing, metadata post-filter or source call.

The response includes exact view/build identity and `{generation, sourceFence, lagMs}`. Generic JSON is not the consumer contract: callers use a typed view adapter, and unknown fields/accesses/views reject.

## Alpha.4 reconciliation

`createDshAlpha4ViewSource`:

1. subscribes before source discovery;
2. obtains bounded source records (optionally enriched from alpha.4 persistence snapshots with revision/cursor);
3. reads durable qq-index partition checkpoints in batches;
4. skips only exact source-identity + durable-revision + next-cursor matches;
5. observes unverifiable/changed sessions through stock `observeSession`, validates the immutable cut, runs the compiled projector, atomically replaces the partition, and always disposes the lease;
6. buffers/deduplicates live changes, drains them after the list fence, and activates only after catch-up;
7. transactionally deletes disposed partitions and marks the view failed on startup/reconciliation failure.

Stock alpha.4 `SessionRecord` has no revision. Without an enriched lightweight revision/cursor record, the safe behavior is observe/replace, never an unchanged guess. Alpha.4 has no global corpus fence; the reported fence explicitly records the adapter-local subscribe/list/drain cut.

## Telemetry and SLOs

Every daemon V2 query/mutation/lifecycle/checkpoint operation logs a bounded JSON record with operation, outcome, elapsed duration and error code or returned phase/count timing details. Successful responses also contain structured elapsed/phase/count telemetry. Alpha.4 reconciliation records bounded lifecycle/partition durations and counts. No record contains query literals, document text/snippets, session IDs, workspace IDs/tokens, row keys, database/socket paths, or exception messages/stacks.

Release gates remain:

- warm one-literal p50 <100 ms / p95 <300 ms;
- warm five-literal p50 <250 ms / p95 <750 ms;
- existing-view cold open <2 s;
- live visibility <1 s;
- cancellation <100 ms;
- zero DSH/session-persistence calls during `queryView`;
- authorized result/order parity against the offline exact oracle.

A generated 16,000-row debug-build core observation (20 warm iterations) recorded: one literal p50/p95 28.27/28.93 ms; five literals 141.24/145.22 ms; existing-view reopen 0.57 ms; generated append-to-visible query 1.85 ms; pre-cancelled terminal 0.0046 ms. The five-literal cost is roughly linear at about 5× the one-literal cost because the first handler executes five independently bounded FTS source plans before fusion. This proves the bounded named plan can be materially faster than the measured 48.867 s legacy production call under a controlled derived-state fixture; it is a microbenchmark observation, not end-to-end behavior.

Generated focused tests prove bounds, lifecycle/auth/cursor/recovery behavior and the synthetic core gates. They do **not** claim production or IPC/corpus-scale SLO qualification. Production replay fixtures, end-to-end corpus benchmarks and shadow soak are required before cutover.

## Deliberate exclusions

This proof assumes trusted local deployment, few compiled views, rebuildable derived state, and simple readiness. It does not add hostile multi-tenancy, audit/security policy, runtime schema/SQL DSL, arbitrary ad-hoc query planning, cross-view joins, or atomic cross-view activation. A future descriptor/code-generator may be extracted only after at least three real views demonstrate repetition.
