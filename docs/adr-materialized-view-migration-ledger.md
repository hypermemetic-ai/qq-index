# ADR/postmortem: migrate session search to compiled views without losing evidence

Date: 2026-09-02  
Status: accepted and implemented as a shadow proof slice

## Incident evidence

The authorized production search took 48,867.021 ms inside the tool: daemon search 874.859 ms, exact verification 42,539.013 ms, metadata authorization 5,450.553 ms, title formatting 0.599 ms, with about 1.997 ms residual. This is a failed performance outcome. The 96,455 ms external envelope includes scheduling/dispatch/serialization and is not search latency. No exact verifier subphase share was measured; read/decode/replay/fold shares remain hypotheses until instrumented.

The current boundary is leaky: qq-index exports an unbound verifier and qq-core passes broad `sessionQuery` authority back into it, then performs a second corpus metadata filter. The rc.7 grouped helper still resolves complete persisted sessions. “Batch” bounded request/result count, not source bytes/replay/folding. The durable fix is query-time derived state, not another batch wrapper or rc.7 patch.

## Decision

Adopt trusted compiled qq-index-local views and named bounded plans. DSH alpha.4 supplies source observations/change foundations; qq-index materializes, authorizes and serves. Unsupported shapes fail explicitly. Preserve the old route and exact verifier until separately coordinated alpha.4 deployment, shadow parity and rollback gates pass.

## Keep/move/oracle/retire ledger

| Current asset/lesson | Disposition now | Target/home | Retirement gate |
|---|---|---|---|
| V1 `searchBatch`, UDS framing, same-UID checks, admission, cancellation, redaction | **Keep** | Legacy rollback adapter and shared daemon infrastructure | Keep framing/infrastructure; retire only V1 operation after cutover |
| `verifyDshSearchCandidates`, selection/ranking/truncation/cancellation tests | **Oracle** | Offline/shadow reference via `session-index-shadow-adapter.mjs` | Parity + shadow soak + rollback window |
| Exact event extraction, title/snippet and surface semantics | **Move** | `qq.session.conversation@1` projector/closed result tests | Only after alpha.4 canonical-fold parity |
| Replacement/surface/delete correctness fixtures | **Move/keep** | V2 partition mutation tests | Never discard; become handler contract tests |
| Authorization-before-ranking and scope-token tests | **Move/keep** | Typed adapter + in-plan handler predicate | Never discard |
| Subscribe-before-list/buffer/drain, idempotency/checkpoint/revision lessons | **Move** | `dsh-alpha4-view-source.mjs` + V2 checkpoints | Never discard |
| PR #30 unchanged production cursor fast path | **Keep honestly** | V1 rollback source synchronization | Remove with V1 source path; it is not query remediation |
| rc.7 `readEventDocumentSnapshots` patch/history/tests | **Evidence only** | qq-core pinned-patch history | Do not forward-port; delete after alpha.4 cutover/rollback window |
| Broad caller-supplied `sessionQuery` pass-through | **Retire later** | Replaced by private alpha.4 adapter + `queryView` | Shadow parity, alpha.4 deployment, rollback approval |
| qq-core second `filterSessions` metadata pass | **Retire later** | Authorization inside compiled plan | Same cutover gate |
| Legacy raw/SQLite/FTS fallback temptation | **Forbidden lesson** | Typed unsupported/building/stale errors | Never introduce |
| Production replay fixtures and corpus benchmarks | **Keep** | V2 parity/SLO release suite | Never discard |
| Measured phase spans/failure modes | **Keep/extend** | Bounded no-content operational telemetry | Never discard |

## Compatibility and deployment

The forward target is DSH `0.1.2-alpha.4` (`dsh-v0.1.2-alpha.4`, `4e84901e6471b79ec0338099867ebb4606d12bb5`), coordinated with qq-ui's rewrite. The existing public web contract compiles unchanged, but qq-ui/model gates and the shared host upgrade are separate deployment work. Do not treat rc.7 as the target and do not copy the grouped-session patch forward.

This change does not restart or HMR the shared host, modify qq-core's intentional dirty files, publish branches, or cut over `/find-session`. On deployment, build/backfill side-by-side, run shadow comparison, atomically activate the view alias, retain the previous DB/build for rollback, and coordinate active children before any separately authorized host restart.

## Consequences and follow-ups

- Initial disk/source work can duplicate across views; each physical build is isolated for failure/rebuild/rollback clarity.
- No atomic cross-view join exists.
- Stock alpha.4 lacks a global corpus fence and lightweight records do not contain revision. The adapter requires revision-enriched source records to skip unchanged sessions; otherwise it safely observes.
- The proof has one real view plus a test-only exact/range view. Add real views locally, not by extending qq-core.
- Corpus-scale SLO, live visibility and long shadow soak remain mandatory release evidence; tiny generated timing is not production latency.
