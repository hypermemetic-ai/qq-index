# qq-index

`@hypermemetic-ai/qq-index` is a private ECMAScript-module package whose declared purpose is **bounded repository orientation in `README.md`**. Its package entry and root export are both [`src/plugin.mjs`](src/plugin.mjs); [`package.json`](package.json) is authoritative for the package surface and scripts.

## Run and verify

```sh
npm test
npm run benchmark:session-history
npm run benchmark:session-history:scaled
npm run daemon:build
npm run daemon:test
npm run test:session-index-e2e
npm run test:session-index-dsh-e2e
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`npm test` runs the Node-based suite across the plugin, index, harvest, history-shadow, session-history benchmark, writer-boot, refresh, and daemon/client E2E paths. Both benchmark tasks invoke [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py) with Python 3; the scaled task adds `--mode scaled`. The Cargo commands are also available as `npm run rust:fmt`, `npm run rust:clippy`, and `npm run rust:test`.

[`qq-session-index-core`](crates/session-index-core/Cargo.toml) is the Phase 1A single-connection library for the independent derived SQLite FTS5 index. Phase 1B adds the [`qq-session-indexd`](crates/session-indexd/Cargo.toml) binary and the package subpaths [`@hypermemetic-ai/qq-index/session-index-client`](src/session-index-client.mjs) and [`@hypermemetic-ai/qq-index/session-index-dsh-source`](src/session-index-dsh-source.mjs). The daemon accepts explicit `--socket`, `--database`, and exactly one of `--create`/`--open`, listens only on a private Unix-domain socket, accepts up to 32 concurrent clients while serializing operations on the existing core mutex, and serves bounded versioned `health`, `sourceState`, `applyBatch`, `searchBatch`, and same-UID `shutdown` requests. For example:

```sh
cargo run --package qq-session-indexd -- \
  --socket /absolute/private/runtime/index.sock \
  --database /absolute/private/index.db \
  --create
```

SQLite, FTS, and RRF execute only in Rust. The daemon still has one core connection and no active `sqlite3_interrupt`; its health capability honestly reports `activeSqliteInterrupt: false`. The DSH source module supplies `createDshSessionIndexSource`, `projectDshSessionLog`, `deriveWorkspaceScopeToken`, and `verifyDshSearchCandidates`. It subscribes before listing, projects one row per contiguous raw sequence (empty body for structural events), resumes from durable `sourceState` cursors, chunks deterministic idempotent batches, and rereads live sessions through one bounded serialized queue. `status()` exposes only bounded phase/count/watermark/error-class data, never query text or session IDs.

The scope token is `w` plus 63 lowercase hex characters from a domain-separated SHA-256 digest of the workspace ID. Derivation is mechanical and exported so a thin qq-core adapter can compute the token for an already-authorized workspace; it does not encode a grant or decide authorization. Search now has a bounded `eventTypeAllowList` SQL predicate in addition to surface/workspace/session/as-of bounds.

This remains an append-only bridge. Replacement events can leave old current/shadowed surface labels until targeted repair lands; callers must allow both conversation labels wherever policy does not distinguish them. `session/disposed` never blindly deletes because source persistence may still own the log; it is recorded for a later corpus sync, and stale hits must fail the exported exact-read verifier. Deferred work is a reader pool and active SQLite interrupt/progress cancellation, a durable administrative pause/job table, deletion and targeted surface repair, production metrics/shadow rollout, and the thin qq-core mount/cutover. All tests use only fresh generated temporary databases and unrelated generated literals; they must never target real session or corpus paths.

There is no declared start script or repository-specific install script. The package instead declares two executable entry points:

- `qq-index-refresh` → [`bin/qq-index-refresh`](bin/qq-index-refresh)
- `qq-index-history-shadow` → [`bin/qq-index-history-shadow`](bin/qq-index-history-shadow)

## Map and route changes

| Area | First files to inspect | Verification or detail |
| --- | --- | --- |
| Package integration | [`src/plugin.mjs`](src/plugin.mjs) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Index and harvest paths | [`src/index.mjs`](src/index.mjs), [`src/harvest.mjs`](src/harvest.mjs) | [`tests/index.mjs`](tests/index.mjs), [`tests/harvest.mjs`](tests/harvest.mjs) |
| Refresh-named changes | [`bin/qq-index-refresh`](bin/qq-index-refresh), [`src/refresh.mjs`](src/refresh.mjs) | [`tests/refresh.mjs`](tests/refresh.mjs) |
| Writer-named artifacts | [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml), [`src/model-pass.mjs`](src/model-pass.mjs), [`src/writer-boot.mjs`](src/writer-boot.mjs) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs) |
| History shadow and session-history work | [`bin/qq-index-history-shadow`](bin/qq-index-history-shadow), [`src/history-shadow.mjs`](src/history-shadow.mjs) | [`tests/history-shadow.mjs`](tests/history-shadow.mjs), [`docs/session-history-indexing.md`](docs/session-history-indexing.md) |
| Rust session-index core | [`crates/session-index-core/Cargo.toml`](crates/session-index-core/Cargo.toml), [`crates/session-index-core/src/lib.rs`](crates/session-index-core/src/lib.rs) | `cargo test --workspace` |
| Session-index daemon and Node client | [`crates/session-indexd/src/main.rs`](crates/session-indexd/src/main.rs), [`src/session-index-client.mjs`](src/session-index-client.mjs) | `npm run test:session-index-e2e` |
| DSH source projection/feed and exact verification | [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs) | `npm run test:session-index-dsh-e2e` (generated/fake source only) |

[`src/harvest.mjs`](src/harvest.mjs) has the highest recorded relative-module fan-in (four distinct tracked importers), so changes there merit the full test suite. Beyond the package and executable mappings above, file names alone do not establish runtime wiring; confirm imports before treating similarly named files as a pipeline.

## Existing operational detail

- Session-history design and experiment notes: [`docs/session-history-indexing.md`](docs/session-history-indexing.md) and [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md).
- Repository and writer configuration: [`config/repositories`](config/repositories) and [`config/writer.patch.yml`](config/writer.patch.yml).
- Tracked systemd user units: [`systemd/user/qq-index.service`](systemd/user/qq-index.service) and [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer). No enable/start procedure is declared in the package scripts.
