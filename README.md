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
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

`npm test` runs the Node-based suite across the plugin, index, harvest, history-shadow, session-history benchmark, writer-boot, refresh, and daemon/client E2E paths. Both benchmark tasks invoke [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py) with Python 3; the scaled task adds `--mode scaled`. The Cargo commands are also available as `npm run rust:fmt`, `npm run rust:clippy`, and `npm run rust:test`.

[`qq-session-index-core`](crates/session-index-core/Cargo.toml) is the Phase 1A single-connection library for the independent derived SQLite FTS5 index. Phase 1B.1 adds the [`qq-session-indexd`](crates/session-indexd/Cargo.toml) binary and the package subpath [`@hypermemetic-ai/qq-index/session-index-client`](src/session-index-client.mjs). The daemon accepts explicit `--socket`, `--database`, and exactly one of `--create`/`--open`, listens only on a private Unix-domain socket, and serves bounded versioned `health`, `applyBatch`, `searchBatch`, and same-UID `shutdown` requests. For example:

```sh
cargo run --package qq-session-indexd -- \
  --socket /absolute/private/runtime/index.sock \
  --database /absolute/private/index.db \
  --create
```

This is a deliberately serialized transport vertical slice, not the complete production service. SQLite, FTS, and RRF execute only in Rust, but the daemon still has one core connection and no active `sqlite3_interrupt`; its health capability reports `activeSqliteInterrupt: false`. A reader pool, active cancellation/progress handling, DSH projection adapter, fenced resumable backfill, live feed/checkpoints, metrics, qq-core integration, and shadow cutover remain later work. All tests use only fresh generated temporary databases and unrelated generated literals; they must never target real session or corpus paths.

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

[`src/harvest.mjs`](src/harvest.mjs) has the highest recorded relative-module fan-in (four distinct tracked importers), so changes there merit the full test suite. Beyond the package and executable mappings above, file names alone do not establish runtime wiring; confirm imports before treating similarly named files as a pipeline.

## Existing operational detail

- Session-history design and experiment notes: [`docs/session-history-indexing.md`](docs/session-history-indexing.md) and [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md).
- Repository and writer configuration: [`config/repositories`](config/repositories) and [`config/writer.patch.yml`](config/writer.patch.yml).
- Tracked systemd user units: [`systemd/user/qq-index.service`](systemd/user/qq-index.service) and [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer). No enable/start procedure is declared in the package scripts.
