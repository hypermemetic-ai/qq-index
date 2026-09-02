# qq-index

`@hypermemetic-ai/qq-index` is a private ESM package for bounded repository orientation in `README.md`. Its package entry point is [`src/plugin.mjs`](src/plugin.mjs).

The manifest declares neither an install command nor a generic `start` script, and it does not pin Node or Rust versions. The commands below are the tasks the package does establish.

## Run the established tasks

| Command | Purpose established by the manifest |
| --- | --- |
| `npm test` | Run the declared Node test chain, including both session-index end-to-end tests. |
| `npm run test:session-index-dsh-e2e` | Run the DSH-source end-to-end test alone. |
| `npm run test:session-index-e2e` | Run the client end-to-end test alone. |
| `npm run rust:fmt && npm run rust:clippy && npm run rust:test` | Check formatting, lint all workspace targets with warnings denied, then test the Rust workspace. |
| `npm run daemon:build` | Build the `qq-session-indexd` binary. |
| `npm run daemon:test` | Test the `qq-session-indexd` package. |

Session-history benchmark tasks are `npm run benchmark:session-history` and `npm run benchmark:session-history:scaled`; both use [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py).

## Entry points and boundaries

The declared JavaScript package surface is:

| Package path | Source |
| --- | --- |
| `.` | [`src/plugin.mjs`](src/plugin.mjs) |
| `./session-index-client` | [`src/session-index-client.mjs`](src/session-index-client.mjs) |
| `./session-index-dsh-source` | [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs) |
| `./session-index-runtime` | [`src/session-index-runtime.mjs`](src/session-index-runtime.mjs) |
| `./session-index-launcher` | [`src/session-index-launcher.mjs`](src/session-index-launcher.mjs) |

The manifest also declares three executable entry points:

- `qq-index-refresh` → [`bin/qq-index-refresh`](bin/qq-index-refresh)
- `qq-index-history-shadow` → [`bin/qq-index-history-shadow`](bin/qq-index-history-shadow)
- `qq-session-indexd-launch` → [`bin/qq-session-indexd-launch`](bin/qq-session-indexd-launch)

Beyond that public surface, the main repository boundaries are:

- **JavaScript implementation:** [`src/`](src/plugin.mjs), with [`src/harvest.mjs`](src/harvest.mjs) having the highest relative-module fan-in in the supplied index; [`src/index.mjs`](src/index.mjs), [`src/model-pass.mjs`](src/model-pass.mjs), and [`src/refresh.mjs`](src/refresh.mjs) are the next shared internal points.
- **Writer inputs:** [`prompts/writer.md`](prompts/writer.md) and [`config/writer.patch.yml`](config/writer.patch.yml).
- **Rust workspace:** the root [`Cargo.toml`](Cargo.toml), [`crates/session-index-core/src/lib.rs`](crates/session-index-core/src/lib.rs), and [`crates/session-indexd/src/lib.rs`](crates/session-indexd/src/lib.rs).
- **Service packaging:** [`systemd/user/qq-index.service`](systemd/user/qq-index.service), [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer), and [`systemd/user/qq-session-indexd.service`](systemd/user/qq-session-indexd.service).

## Route a change

These are navigation pairs supported by declared exports/scripts and matching tracked paths; read the implementation before assuming a deeper runtime relationship.

| Change area | Start in | Focused verification / detail |
| --- | --- | --- |
| Package plugin | [`src/plugin.mjs`](src/plugin.mjs) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Index, harvest, or refresh path | [`src/index.mjs`](src/index.mjs), [`src/harvest.mjs`](src/harvest.mjs), [`src/refresh.mjs`](src/refresh.mjs) | [`tests/index.mjs`](tests/index.mjs), [`tests/harvest.mjs`](tests/harvest.mjs), [`tests/refresh.mjs`](tests/refresh.mjs) |
| Writer boot or model pass | [`src/writer-boot.mjs`](src/writer-boot.mjs), [`src/model-pass.mjs`](src/model-pass.mjs) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs), [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml) |
| Session-index JavaScript surface | The four exported `session-index-*` modules above | [`tests/session-index-runtime.mjs`](tests/session-index-runtime.mjs), [`tests/session-index-launcher.mjs`](tests/session-index-launcher.mjs), [`tests/session-index-capabilities.mjs`](tests/session-index-capabilities.mjs), and the two E2E scripts named above |
| Rust core/search | [`crates/session-index-core/src/lib.rs`](crates/session-index-core/src/lib.rs), [`crates/session-index-core/src/search.rs`](crates/session-index-core/src/search.rs) | [`crates/session-index-core/tests/phase1a.rs`](crates/session-index-core/tests/phase1a.rs), then `npm run rust:test` |
| Rust daemon/protocol | [`crates/session-indexd/src/server.rs`](crates/session-indexd/src/server.rs), [`crates/session-indexd/src/protocol.rs`](crates/session-indexd/src/protocol.rs) | [`crates/session-indexd/tests/daemon_protocol.rs`](crates/session-indexd/tests/daemon_protocol.rs), then `npm run daemon:test` |
| History shadow | [`src/history-shadow.mjs`](src/history-shadow.mjs), [`src/history-shadow-cli.mjs`](src/history-shadow-cli.mjs) | [`tests/history-shadow.mjs`](tests/history-shadow.mjs), [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md) |

For deeper session-index context, use [`docs/session-history-indexing.md`](docs/session-history-indexing.md) and [`docs/session-index-production.md`](docs/session-index-production.md).
