# qq-index

`@hypermemetic-ai/qq-index` is a private ESM package for **bounded repository orientation in `README.md`**. Its main package entry is [`src/plugin.mjs`](src/plugin.mjs); [`package.json`](package.json) also exports the session-index client, DSH source, runtime, and launcher modules.

## Run the established tasks

Run scripts from the repository root:

```sh
npm test                    # Node test suite, including both session-index E2E suites
npm run rust:fmt            # check Rust formatting
npm run rust:clippy         # lint the Rust workspace with warnings denied
npm run rust:test           # test the Rust workspace
npm run daemon:build        # build qq-session-indexd
npm run daemon:test         # test qq-session-indexd
```

There is no `start` script. The package declares three executables: [`qq-index-refresh`](bin/qq-index-refresh), [`qq-index-history-shadow`](bin/qq-index-history-shadow), and [`qq-session-indexd-launch`](bin/qq-session-indexd-launch). Their arguments and runtime behavior are not described by the package metadata; [`package.json`](package.json) is authoritative for the declared mappings.

For performance work, the declared benchmarks are `npm run benchmark:session-history` and `npm run benchmark:session-history:scaled`, both backed by [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py).

## System map

- **README orientation:** [`src/plugin.mjs`](src/plugin.mjs) is the package main. Frequently imported internal boundaries include [`src/harvest.mjs`](src/harvest.mjs), [`src/index.mjs`](src/index.mjs), [`src/model-pass.mjs`](src/model-pass.mjs), and [`src/refresh.mjs`](src/refresh.mjs). Writer-related files include [`prompts/writer.md`](prompts/writer.md) and [`config/writer.patch.yml`](config/writer.patch.yml).
- **Session-index JavaScript surface:** the declared subpath exports are [`src/session-index-client.mjs`](src/session-index-client.mjs), [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs), [`src/session-index-runtime.mjs`](src/session-index-runtime.mjs), and [`src/session-index-launcher.mjs`](src/session-index-launcher.mjs).
- **Rust workspace:** [`crates/session-index-core`](crates/session-index-core/Cargo.toml) contains the core crate and search source; [`crates/session-indexd`](crates/session-indexd/Cargo.toml) contains the daemon crate, including its CLI, protocol, runtime, and server boundaries.
- **Operations:** the executable wrappers are linked above. Tracked service definitions include [`qq-index.service`](systemd/user/qq-index.service), [`qq-index.timer`](systemd/user/qq-index.timer), and [`qq-session-indexd.service`](systemd/user/qq-session-indexd.service); additional repository configuration is tracked in [`config/repositories`](config/repositories).

JavaScript is ESM (`"type": "module"`). The default `npm test` command does not run the Rust workspace checks, so run the `rust:*` scripts when changing Rust code.

## Route a change

| Change | Start here | Tests / checks |
| --- | --- | --- |
| Package integration | [`src/plugin.mjs`](src/plugin.mjs) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Index or refresh flow | [`src/index.mjs`](src/index.mjs), [`src/refresh.mjs`](src/refresh.mjs) | [`tests/index.mjs`](tests/index.mjs), [`tests/refresh.mjs`](tests/refresh.mjs) |
| Writer/model pass | [`src/model-pass.mjs`](src/model-pass.mjs), [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs) |
| Session-index JS boundary | The relevant exported module listed above | [`tests/session-index-runtime.mjs`](tests/session-index-runtime.mjs), [`tests/session-index-capabilities.mjs`](tests/session-index-capabilities.mjs), and the client/DSH [E2E](tests/session-index-client.e2e.mjs) [tests](tests/session-index-dsh-source.e2e.mjs) |
| Core search | [`crates/session-index-core/src/search.rs`](crates/session-index-core/src/search.rs) | [`crates/session-index-core/tests/phase1a.rs`](crates/session-index-core/tests/phase1a.rs), `npm run rust:test` |
| Daemon protocol or server | [`crates/session-indexd/src/protocol.rs`](crates/session-indexd/src/protocol.rs), [`crates/session-indexd/src/server.rs`](crates/session-indexd/src/server.rs) | [`crates/session-indexd/tests/daemon_protocol.rs`](crates/session-indexd/tests/daemon_protocol.rs), `npm run daemon:test` |

## Authoritative detail

- [`docs/session-history-indexing.md`](docs/session-history-indexing.md) — session-history indexing
- [`docs/session-index-production.md`](docs/session-index-production.md) — production session-index material
- [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md) — history-shadow experiment
