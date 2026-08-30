# Session-history indexing: engine decision and `SearchBatchV1` contract

Status: **accepted design; Phase 1A single-connection core implemented and synthetic tests passing; production service not yet implemented**
Decision owner: **qq-index**
Assessment snapshot: **2026-08-30**
Turso source pin: [`tursodatabase/turso@6ab76b29a2a1e3d19866e792f2e9929aff65e08d`](https://github.com/tursodatabase/turso/tree/6ab76b29a2a1e3d19866e792f2e9929aff65e08d)
rusqlite source pin: [`rusqlite/rusqlite@a8f0a07bf65b28c05fa54b260d39707368ad9ed3`](https://github.com/rusqlite/rusqlite/tree/a8f0a07bf65b28c05fa54b260d39707368ad9ed3)

This record assigns the durable session-history index to qq-index, rejects Turso
Database as the first production engine, and selects a Rust service using mature
upstream SQLite FTS5. It also fixes the versioned, policy-neutral boundary that
qq-core can adapt to. The checked-in benchmark is a synthetic storage-shape
microbenchmark, not that service and not a production SLO qualification.

### Implementation status

Phase 1A is implemented in the `qq-session-index-core` Rust library and is only
considered implemented while `cargo fmt --check`, strict workspace clippy, and
`cargo test --workspace` pass. This milestone is deliberately one synchronous
connection: it proves the independent versioned database, atomic projected
mutation/idempotency model, scope-intersected bounded FTS retrieval, one-snapshot
five-literal search, and deterministic reciprocal-rank fusion. It does **not**
claim concurrent production serving or active cancellation.

Remaining Phase 1B+ work is explicit: daemon and UDS protocol, bounded reader
pool, cross-thread interrupt/deadline coordinator, raw DSH adapter, resumable
backfill, production metrics, and qq-core shadow cutover. None of those run
implicitly during `SessionIndex::open` or `search_batch_v1`.

## Safety and ownership

The incident request and its literals must not be replayed. No benchmark may
open, copy, inspect, or query a real session database or live-log directory.
[`benchmarks/session_history_fts5.py`](../benchmarks/session_history_fts5.py)
has closed inputs: it accepts only a generated fixture size and iteration count,
uses unrelated built-in vocabulary, creates a fresh temporary database, and
removes it before emitting JSON. It has no database/corpus/session/query/output
path option. Tests enforce that boundary.

Responsibilities remain split as follows:

- **qq-index:** durable index schema and lifecycle; incremental ingestion;
  explicit resumable backfill; pooled retrieval; 1–5-literal batch search;
  deterministic fusion primitives; snapshot, isolation, cancellation and
  deadline behavior; service metrics; stable capability/version handshake; and
  storage-level performance gates.
- **qq-core:** gesture/grant checks; workspace, conversation-only, session and
  as-of policy; conversion of those decisions to authorized primitive filters;
  schema consumed by the model; result formatting; and final verification
  against exact visible conversation text.
- **qq-workflows:** architecture and delegation tools only.

qq-index must never infer authorization policy. Its service accepts already
normalized literals, primitive authorized bounds, and opaque authorized scope
tokens derived by qq-core. qq-index indexes those tokens and intersects them
inside retrieval but does not interpret their policy meaning. A candidate or
snippet is still untrusted input to qq-core's final exact-visible-text
verification.

## Incident mechanics and bounded conclusion

The reported call took 488.193 seconds. It started five depth-100 sources with
`Promise.all`, but the mounted
`@deepseek-ai/dsh-session-query-sqlite` `0.1.0-rc.7` provider uses
`node:sqlite` `DatabaseSync` and one promise tail. The apparent parallel calls
therefore queue five serialized reconcile-and-query state machines. Every
search reconciles before `MATCH`; persisted inspection is serial, every live
session is cloned/projected/serialized/fingerprinted, and changed live sessions
are deleted/reinserted into connection-local temporary FTS. Metadata and FTS
statements execute synchronously on the Node event loop, with AbortSignal checks
only before and after uninterruptible statements. Filters constrain returned
rows, not reconciliation work.

A separately verified qq-core multiplier exists: `verifyCandidates` nests
`Promise.all` across up to the final limit and each candidate's evidence
contributions. At a limit of 20 and five clues, it can issue up to 100 concurrent
`readConversationDocument` / `sessionQuery.readEvent` calls before title reads.
This is a fan-out hazard, but no phase telemetry establishes that it—or any
other phase—dominated the 488.193 seconds. The synthetic harness tests the FTS
batch and snapshot shape only; it does not purport to reproduce the incident.

The public DSH upstream checked during the assessment remained a TypeScript
`node:sqlite` provider. No concurrent Rust rewrite was present there.

## Turso investigation

### Product identity

The operator's hint resolves to **Turso Database**, formerly **Limbo**, in
[`tursodatabase/turso`](https://github.com/tursodatabase/turso). That is the
from-scratch Rust SQLite-compatible database and the project assessed here.
It is not either of the following:

- **libSQL:** the older SQLite fork in
  [`tursodatabase/libsql`](https://github.com/tursodatabase/libsql), with a
  different implementation and compatibility history.
- **hosted Turso / Turso Cloud:** the managed service and its remote/serverless
  client drivers. A Cloud driver does not imply that queries execute in the
  local Rust rewrite or off the local Node event loop.

At the pinned assessment, the latest stable Turso Database release and native
Node package `@tursodatabase/database` were 0.7.2; 0.8.0-pre releases were
prereleases. The repository is MIT licensed. Turso describes the engine as in
production, but it remains pre-1.0 and its guidance recommends independent
backups. “In production” is not a compatibility, durability, or support SLA.

### I/O, CPU execution, and concurrency

Turso's asynchronous I/O, including Linux `io_uring` paths, can avoid waiting
for storage on a calling thread. It does **not** make one CPU-bound query execute
in parallel, nor does it by itself move binding work off Node's main thread.
These concerns must be evaluated independently:

- Default WAL permits readers while a writer commits. One connection has one
  transaction; callers need separate connections for actual concurrent work.
- `BEGIN CONCURRENT` relies on experimental MVCC. At the audit pin, the MVCC
  documentation warned that it could not use indexes, eagerly loaded a
  database, had blocking checkpoints, might panic, and might return incorrect
  results. Experimental multi-process WAL was explicitly unsuitable for
  critical data. Those paths cannot underwrite this index's durability or SLO.
- The released/current Node binding executes statement stepping through
  `stepSync()` on the main thread and serializes a `Database` with a JavaScript
  `AsyncLock`. Source comments say the connection/database types are not fully
  thread-safe and use an unsafe `Send` shim during connection setup. Thus its
  promise-shaped API does not provide off-event-loop CPU execution.
- Current Node APIs include query-timeout machinery, but `Database.interrupt()`
  and `Statement.interrupt()` are `not implemented`. No inspected Node or Rust
  binding surface supplied a direct AbortSignal-to-active-statement contract
  with a measurable cancellation acknowledgement. A timeout is not equivalent
  to prompt, externally requested cancellation.

Rust-native integration could avoid the particular JavaScript lock, but would
still need a supported FTS implementation, worker ownership, interrupt
semantics, snapshot guarantees, and crash isolation. Merely changing binding
language does not establish those properties.

### SQLite and FTS compatibility

[`COMPAT.md`](https://github.com/tursodatabase/turso/blob/6ab76b29a2a1e3d19866e792f2e9929aff65e08d/COMPAT.md)
records partial SQLite compatibility and prohibits mixed SQLite/Turso
multi-process access to one database. SQLite FTS3/4/5 are explicitly
unsupported. Turso instead has a distinct, experimental Tantivy-backed
full-text index with different DDL, functions, tokenizers, and ranking. It does
not provide SQLite `snippet()` or external-content FTS tables, requires manual
segment optimization, and does not provide read-your-writes before commit.

Consequently the existing or proposed SQLite FTS5 schema, query text,
`bm25`/snippet behavior, tokenizer expectations, and migration tooling cannot
be reused unchanged. Opening one physical database alternately with SQLite and
Turso is not a migration strategy.

### Benchmark relevance

Synthetic observations from the investigation are retained as observations,
not product shoot-out scores or hardcoded gates:

| Fixture and method | Observation | Limits |
| --- | --- | --- |
| SQLite FTS5, 16,000 generated docs | Warm one literal p50/p95 0.957/1.055 ms; five serial literals 4.824/5.076 ms; reopen+query 1.051 ms. A fresh worker process took p50 19.457 ms wall while SQLite work was 1.146 ms. | Tiny, warm synthetic fixture; demonstrates why workers should persist, not an end-to-end SLO. |
| SQLite FTS5, 250,000 generated docs, 1,000 generated sessions, seven workspaces, about 146.6 MB | Filtered/grouped top-101 one literal p50/p95 5.18/6.68 ms; five literals in one read transaction 45.55/48.12 ms; warm handle reopen 0.16 ms. | Synthetic selectivity/content; length rank rather than DSH highlighted-span count; no snippets, IPC, queue, or qq-core verification. Headroom, not qualification. |
| Adversarial SQLite FTS5, 250,000 generated docs where every document matched all five terms | With workspace only as a SQL predicate: one p50/p95 195/201 ms and five 959/968 ms. Adding a dedicated opaque 1-of-7 scope token and intersecting it inside `MATCH`: one 77.9/83.0 ms and five 386.5/392.0 ms. | Scoped one-literal met both targets. Scoped five-literal met p95 <750 ms but **missed p50 <250 ms**. Scope pruning is necessary but insufficient; broad-query scan/work bounds still require qualification. This does not validate arbitrary token cardinality, ranking, IPC, or production content. |
| SQLite FTS5 WAL synthetic probes | A reader remained at count 1 across a concurrent writer commit in one read transaction and saw count 2 after commit. Fifty warm one-row incremental append+commit+first-reader-MATCH probes over 10,000 base docs were p50/p95 0.089/0.143 ms, max 2.298 ms. | Verifies SQLite mechanism/storage shape only; not DSH event-delivery visibility. |
| SQLite interruption synthetic probe | Cross-thread `sqlite3_interrupt` of an in-memory long query acknowledged p50/p95 0.092/0.134 ms, max 0.230 ms over 20 samples. | Mechanism only; excludes service queue, IPC, scheduling, cleanup, and connection retirement. |
| Turso Node 0.7.2, 1,000 generated docs, experimental `index_method` | SQLite `CREATE VIRTUAL TABLE ... USING fts5` was rejected. Ingest took about 22.27 s; warm one literal p50/p95 16.085/18.848 ms and five serial 79.411/83.332 ms. A 1 ms timer was delayed roughly 16–19 ms, matching one query. | Compatibility and event-loop smoke test, not a fair optimized-engine comparison. Different FTS/index maturity and ingest path. |

All observations used generated data and unrelated terms. Cache state, process
startup, query shape, ranking, tokenization, snippets, concurrency, and binding
cost must be matched before comparing numbers. The checked-in harness reports
its own methodology and observations dynamically; it does not embed these as
pass thresholds.

### Decision

**Do not use Turso Database as qq-index's first durable production engine.** It
is valuable to watch and potentially shadow later, but today it would require a
full FTS schema/query/ranking migration, accepts experimental FTS and durability
risk, fails the required SQLite FTS5 compatibility, leaves CPU work on the Node
main thread through the current binding, and lacks the required exposed
cancellation contract.

## Selected engine and process architecture

Build a small Rust service around mature upstream SQLite using
[`rusqlite` at the audited revision](https://github.com/rusqlite/rusqlite/tree/a8f0a07bf65b28c05fa54b260d39707368ad9ed3)
or an equivalently mature binding. `rusqlite` is MIT licensed and actively maintained; it can bundle a
known SQLite build with FTS5, gives a connection single-thread ownership via
`Send`, exposes a `Send + Sync` `InterruptHandle` backed by
[`sqlite3_interrupt`](https://sqlite.org/c3ref/interrupt.html), and supports
SQLite progress handlers as an additional bounded-VM-work guard.

The preferred Node boundary is a versioned protocol over a Unix-domain socket
to an out-of-process service. This gives event-loop isolation, CPU parallelism
across workers, and database crash/failure isolation. A N-API implementation is
acceptable only if every SQLite operation and result materialization runs on a
bounded native worker and its cancellation path can be proved; an async-looking
JavaScript method is not sufficient.

The service owns:

1. one serialized writer connection;
2. a fixed-size pool of read-only connections, each exclusively owned by a
   dedicated Rust worker/thread;
3. a coordinator that admits bounded work, accounts deadline queue time, and
   routes cancellation without waiting behind database work; and
4. checkpoint/migration/backfill workers that never run implicitly on a search
   or ordinary open path.

A worker executes only one request at a time. Different callers get actual
concurrent reads on different connections and CPU workers. Inside one caller's
1–5-literal batch, queries run serially on one reader connection in one explicit
read transaction. This is intentional: it gives one WAL snapshot without the
experimental `sqlite3_snapshot` API. Parallelizing five literals over five
connections would lose that simple one-snapshot guarantee and compete for CPU.
Pool size must be measured and capped; more connections than useful CPU/storage
parallelism increase tail latency.

### Snapshot and writer rules

For a batch, the reader must:

1. `BEGIN` a read transaction;
2. read the index generation/watermark to establish the WAL snapshot;
3. execute all literal sources and fusion inputs on the same connection;
4. read no mutable data outside that transaction; and
5. commit/rollback before returning the worker to the pool.

The serialized writer updates source rows, FTS rows, tombstones, generation,
and source watermark atomically in one transaction. Readers already in a
transaction retain the old snapshot while new transactions see the commit, as
specified by SQLite
[WAL](https://sqlite.org/wal.html) and
[isolation](https://sqlite.org/isolation.html). WAL checkpoints are background
maintenance with latency/size telemetry, never hidden request-path
reconciliation.

Opening an existing index only validates application/schema versions, opens the
bounded connection pool, and reads generation/watermark. It does not list source
sessions, hash logs, reconcile content, migrate, optimize FTS, or backfill.

### Cancellation, deadlines, and isolation

Every request has an absolute deadline; the coordinator converts it to a local
monotonic budget on receipt. Queue time counts. A queued request is removable
without acquiring a database worker. An active reader has an `InterruptHandle`
owned by the coordinator, so cancellation or deadline expiry invokes
`sqlite3_interrupt` from outside the worker. A progress handler provides a
second guard for CPU-heavy VM programs.

A cancellation acknowledgement is the terminal cancelled/deadline response
after the queued item is removed or the active SQLite call has returned—not
merely receipt of an AbortSignal. Measure request-to-ack latency. Because
`sqlite3_interrupt` is connection-scoped, one worker connection serves only one
active request, is not reused until the interrupted statement unwinds, and is
hard-retired/reopened if it fails to unwind within a separately measured grace
bound. Client disconnect sends the same cancellation. Cancellation of one
request must not interrupt another worker or the writer.

## Stable policy-neutral API

The transport may use a compact binary encoding, but its semantics are fixed by
these versioned shapes. Unknown versions or capabilities fail closed. Sizes,
string lengths, candidate depths, and list cardinalities must have protocol
limits even where abbreviated below.

```ts
type SearchBatchV1 = {
  version: "search-batch-v1";
  requestId: string;
  // Already normalized by qq-core. Length must be 1..5.
  literals: string[];
  perSourceDepth: number;
  finalLimit: number;
  filters: {
    // Nonempty, bounded, opaque tokens derived by qq-core and also attached to
    // documents at ingest. Retrieval intersects them inside FTS MATCH.
    authorizedScopeTokens: string[];
    workspaceIds: string[];
    surfaceAllowList: string[];
    includeSessionIds?: string[];
    excludeSessionIds?: string[];
    notBeforeEventTimeUnixMs?: number;
    notAfterEventTimeUnixMs?: number;
    // DSH sequence numbers are session-local. Cardinality is protocol-bounded.
    sessionSeqBounds?: Array<{
      sessionId: string;
      notBeforeSeq?: number;
      notAfterSeq?: number;
    }>;
  };
  // If supplied, fail/return unavailable by the deadline rather than silently
  // searching an older generation.
  minimumSourceWatermark?: string;
  deadlineUnixMs: number;
};

type SearchBatchResponseV1 = {
  version: "search-batch-response-v1";
  requestId: string;
  snapshot: {
    generation: string;       // opaque immutable index generation
    sourceWatermark: string;  // source progress included by this snapshot
    sourceLagMs: number | null;
  };
  sources: Array<{
    queryOrdinal: number;     // does not echo/log literal text
    truncated: boolean;
    truncationReason: "exhausted" | "source-depth" | "posting-budget";
    rawPostingsScanned: number;
    ranked: Array<{
      rank: number;           // one-based, deterministic
      sessionId: string;
      score: number;          // source-local; not comparable across sources
      evidence: {
        sessionId: string;    // self-contained exact-read coordinate
        documentKey: string;
        seq: number;          // session-local coordinate for exact readEvent
        eventTimeUnixMs: number;
        eventType: string;
        surface: string;
        snippet?: string;     // bounded and only from authorized filtered rows
      };
    }>;
  }>;
  fused: Array<{
    rank: number;
    sessionId: string;
    rrfScore: number;
    contributions: Array<{
      queryOrdinal: number;
      sourceRank: number;
      contribution: number;
      documentKey: string;    // best evidence for this source/session
      seq: number;            // session-local coordinate for exact readEvent
      snippet?: string;
    }>;
  }>;
  fusedTruncated: boolean;
};
```

Fusion is deterministic reciprocal-rank fusion with a protocol-fixed constant
(`k = 60` for V1): for each distinct session, sum
`1 / (k + sourceRank)` once per source and retain that source's best evidence
document. Sort descending by RRF score, then by bytewise session ID. Source ranking also has explicit stable session/document keys after engine
score. A later ranking change requires a capability/version change; Turso's rank is not silently
substitutable for FTS5 rank.

A response contains exactly one generation. It must not mix cached source lists
from other generations. `truncated` and `truncationReason` distinguish an
exhausted source from the depth or internal work bound. The service does not
return unfiltered hidden rows or raw session documents. qq-core retains final
evidence verification, title reads, formatting, and policy decisions.

### Scope intersection and bounded retrieval

Post-filtering a broad full-text result by workspace/surface is not sufficient:
the adversarial five-literal observation above exceeded both batch targets
before scope was moved into `MATCH`. Scope intersection brought p95 under its
target but still missed the five-literal p50 target, so it is necessary rather
than sufficient; fixed work bounds and the production streaming query remain
gates. Each projected document therefore carries one or
more opaque scope tokens in a dedicated indexed FTS field. The trusted ingest
adapter obtains those tokens from qq-core's versioned derivation (for example,
an authorized workspace/surface partition); `SearchBatchV1` supplies the
currently authorized tokens. The FTS expression is the conjunction of the
literal field and the OR of those tokens. SQL metadata predicates remain as
defense-in-depth, not the primary way to reduce postings. Tokens have a strict
alphabet/version/cardinality bound, are never logged or emitted as metrics, and
have explicit rotation/reindex semantics. qq-index compares tokens only and
never derives a grant from a workspace or session.

For every literal, the service has a fixed, versioned **raw posting scan
budget** that the caller cannot increase. It streams FTS hits in engine-rank
order on the batch reader, applies bounded metadata checks, and keeps the first
(best) hit for each distinct session. It stops when it has `perSourceDepth`
distinct sessions, exhausts the source, or consumes the posting budget. It must
not window, group, sort, or materialize every textual match before applying
that bound. Depth or budget termination sets `truncated` and the corresponding
reason; the response and metrics report the raw count. Engine progress/deadline
checks still bound VM work needed to produce a ranked posting. Golden tests fix
tie-breaking and verify that one session cannot consume unbounded memory.

Terminal protocol failures are also versioned and never return partial results
from mixed generations:

```ts
type SearchBatchErrorV1 = {
  version: "search-batch-error-v1";
  requestId: string;
  code:
    | "invalid-request"
    | "unsupported-version"
    | "admission-rejected"
    | "watermark-unavailable"
    | "deadline-exceeded"
    | "cancelled"
    | "engine-unavailable";
  retryable: boolean;
  snapshot?: { generation: string; sourceWatermark: string };
};
```

A deadline or cancellation never returns a source list as though it were
complete. `watermark-unavailable` reports the current non-search snapshot only
when safe; the client decides whether to retry within a new policy decision.

Cancellation is a separate coordinator message:

```ts
type CancelV1 = {
  version: "cancel-v1";
  requestId: string;
  reason: "caller" | "deadline" | "disconnect";
};
```

## Incremental ingestion

Search is never responsible for source discovery or repair. A source adapter
turns the DSH event stream into these idempotent operations:

- `appendEvents(sessionId, events[], sourceRevision, idempotencyKey)`: append a
  contiguous monotonic sequence whose projected events carry the trusted,
  versioned opaque scope tokens needed for in-FTS authorization intersection.
  Stable keys include
  `(session_id, seq, source_revision/event_fingerprint)`. Duplicate replay is a
  no-op; a conflicting duplicate or gap fails closed and schedules explicit
  repair.
- `updateHeader(sessionId, headerRevision, fields)`: update only affected
  metadata/index rows.
- `updateScopeTokens(sessionId, scopeRevision, tokens)`: explicitly reproject
  the affected session when the trusted token derivation changes. This is
  background ingest/migration work, never search-path policy evaluation.
- `tombstone(sessionId, seq or documentKey, sourceRevision)`: targeted removal
  in the same transaction as its FTS delete marker.
- `repairSession(sessionId, expectedRevision)`: explicit administrative rebuild
  of one session. It is observable, bounded, resumable, and never called by
  search.

The writer projects only appended/changed events into documents. A normal live
append never clones, expands, fingerprints, deletes, or reinserts a whole
session. Commits atomically advance generation and a durable monotonic source
watermark. The adapter acknowledges ingestion only after that commit. Event
fingerprints protect idempotency; they are not obtained by repeatedly hashing
all live sessions.

## Explicit resumable backfill

Backfill has a durable job record and an administrative API/CLI:

```text
start -> running -> catching-up -> complete
            |  ^          |
            v  |          v
          paused       paused
            |
            v
          failed --resume--> running
```

`start` records schema/projection versions and a source fence. `running` scans
bounded source batches in stable source-key order and commits a checkpoint after
each idempotent batch. `pause` stops after a commit. `resume` validates versions
and continues from the checkpoint, never from zero. Events newer than the fence
are durably buffered or consumed from a replayable offset; `catching-up`
applies them in order, then atomically records the live watermark. Status
includes state, checkpoint, fence, processed/error counts, rate, source lag, and
ETA. Repair and migration use separate job identities.

A source without a stable revision/fingerprint, replayable live offset, and
consistent fence cannot satisfy this design; that is an integration gap to fix,
not a reason to put reconciliation back on search. Crash recovery replays only
idempotent work after the last committed checkpoint.

## Metrics and release gates

Metrics must not contain query text, snippets, transcript IDs, session IDs, or
unbounded request labels. Record bounded dimensions such as operation, outcome,
worker, query-count bucket, and mode. Required histograms/gauges/counters are:

- request queue, snapshot acquisition, FTS-per-literal, posting-scan count and
  budget truncation, fusion, response materialization, and total latency;
- queued/active readers, admission rejection, pool utilization, result and
  candidate counts, and per-source truncation;
- cancellation requested-to-ack, interrupt count/outcome, deadline phase, and
  hard-retired connections;
- ingest queue/commit latency, accepted event count, source watermark/lag, and
  time from adapter receipt to first searchable generation;
- backfill state/checkpoint/rate/ETA/retry/error counts;
- WAL bytes, checkpoint duration/result/busy count, database bytes, and open
  duration; and
- schema/version errors, corruption checks, FTS errors, and writer failures.

The production candidate is not releasable until repeated, isolated performance
runs satisfy all of these targets without request-path reconciliation:

| Gate | Target |
| --- | ---: |
| Warm one-literal search | p50 < 100 ms; p95 < 300 ms |
| Warm five-literal batch | p50 < 250 ms; p95 < 750 ms |
| Cold service/open of an existing index | < 2 s |
| Live visibility, adapter receipt through searchable committed generation | < 1 s |
| Cancellation requested through terminal acknowledgement | < 100 ms |
| Search/open whole-corpus work | zero reconciliations/backfills |

The checked-in Python harness uses selective generated terms and measures only
warm FTS, same-process read-only handle reopen, and WAL snapshot mechanics. Its
current grouped query is deliberately not the production streaming retriever
and does not qualify the adversarial broad-term/scope-token/scan-budget case. Its JSON intentionally labels
latency as an observation, not a gate. A later Rust-service gate must use enough
samples for stable p95s, pin hardware/SQLite/schema/build, include IPC, queueing,
result materialization and cancellation, exercise concurrent readers plus the
writer, start from an existing generated on-disk index for cold-open tests, and
measure event-receipt-to-visible for generated append events. Never qualify on
the reported corpus. Correctness, durability, bounded memory, and cancellation
isolation gates are mandatory even when latency passes.

## Compatibility and migration

The rc.7 index and temporary live overlay are derived data, not an on-disk
compatibility contract. Migration must:

1. create a new, independent, application-ID/versioned SQLite database; never
   point the new service at the rc.7 file or mix engines on one file;
2. start an explicit fenced backfill while durably buffering/replaying newer
   generated source events;
3. catch up and report watermark/lag independently of search;
4. expose a qq-core adapter behind a capability handshake for
   `search-batch-v1`, cancellation, snapshots, and incremental ingest;
5. shadow authorized, policy-neutral candidate sets/generations and compare
   deterministic ranks/evidence without exposing results to users;
6. soak correctness, restore, crash, load, cancellation, and SLO behavior;
7. switch the adapter while preserving the old backend and source offsets for
   rollback; and
8. retire the old derived index only after the rollback window.

SQLite FTS5 tokenizer, escaping, ranking, snippets, document projection, and
source-revision semantics are explicit migration surfaces. Golden generated
fixtures and adapter contract tests must cover them. Turso would require a
separate schema and ranking migration and cannot consume this database in
place.

## Quick mitigation versus durable remediation

Quick mitigations are qq-core-owned: temporarily use one clue (or sharply lower
clue count/depth), add admission/circuit breaking and a hard overall deadline
around an isolated worker/process, bound and deduplicate verification reads per
session, and add phase telemetry around reconcile, FTS, verification, and title
reads. These reduce multipliers. They do not make in-process `DatabaseSync`
preemptible, do not remove request-path reconciliation, and must not be called
the durable fix.

The durable qq-index remediation is the Rust/mature-SQLite service, one-snapshot
batch API and RRF, pooled reader workers, serialized incremental writer,
`sqlite3_interrupt` plus progress-handler cancellation, explicit resumable
backfill, shadow migration, metrics, and synthetic performance/correctness
gates described here.

## Realistic expectations, limitations, and next steps

The 250,000-document SQLite observation leaves substantial storage-query
headroom relative to the target, but it is not an end-to-end forecast. IPC,
queueing, snippets, projection/ranking fidelity, concurrent load, cold cache,
WAL checkpoints, ingestion, and qq-core's final verification can dominate. The
validation targets are engineering budgets, not a latency promise. No evidence
supports attributing or extrapolating the incident's 488.193 seconds to one
phase without telemetry.

Before implementation can ship:

1. finalize DSH stable event sequence/revision/fingerprint and replay/fence
   semantics;
2. freeze document projection, opaque scope-token derivation/rotation and
   cardinality bounds, FTS5 tokenizer/query escaping, raw posting budget,
   streaming/dedup behavior, snippet bounds, metadata schema, and deterministic
   rank golden tests;
3. implement the Rust service, UDS protocol, bounded admission, reader pool,
   serialized writer, interrupt/progress cancellation, and connection
   retirement;
4. implement explicit backfill/repair and crash/restore tests;
5. add qq-core's capability-gated adapter and bounded verification separately,
   without moving policy into qq-index;
6. run generated correctness, race, fault, restore, concurrency, cancellation,
   and performance gates, then shadow and soak; and
7. continue watching Turso only when stable FTS compatibility/migration,
   off-event-loop bindings, supported interrupts, and non-experimental
   durability meet the contract.

## Primary upstream references

These links identify the authoritative surfaces used by the pinned source audit;
release/support facts should be re-audited before implementation because Turso
is pre-1.0.

- [Turso Database repository at the audited commit](https://github.com/tursodatabase/turso/tree/6ab76b29a2a1e3d19866e792f2e9929aff65e08d),
  [compatibility matrix](https://github.com/tursodatabase/turso/blob/6ab76b29a2a1e3d19866e792f2e9929aff65e08d/COMPAT.md),
  [license](https://github.com/tursodatabase/turso/blob/6ab76b29a2a1e3d19866e792f2e9929aff65e08d/LICENSE),
  and [releases](https://github.com/tursodatabase/turso/releases).
- [`@tursodatabase/database` package registry](https://www.npmjs.com/package/@tursodatabase/database)
  and [Turso Database documentation](https://docs.turso.tech/database).
- [libSQL repository](https://github.com/tursodatabase/libsql), retained here to
  make the product distinction explicit.
- [SQLite FTS5](https://sqlite.org/fts5.html),
  [WAL](https://sqlite.org/wal.html),
  [isolation](https://sqlite.org/isolation.html),
  [interrupt](https://sqlite.org/c3ref/interrupt.html), and
  [progress handler](https://sqlite.org/c3ref/progress_handler.html).
- [`rusqlite` audited source](https://github.com/rusqlite/rusqlite/tree/a8f0a07bf65b28c05fa54b260d39707368ad9ed3),
  pinned [`InterruptHandle` source](https://github.com/rusqlite/rusqlite/blob/a8f0a07bf65b28c05fa54b260d39707368ad9ed3/src/lib.rs#L1345-L1361),
  [`InterruptHandle`](https://docs.rs/rusqlite/latest/rusqlite/struct.InterruptHandle.html),
  and [`Connection` auto-traits](https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html).
