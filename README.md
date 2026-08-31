# qq-index

`@hypermemetic-ai/qq-index` is a private ESM package for bounded repository orientation in `README.md`. Its public Node entry point is [`src/plugin.mjs`](src/plugin.mjs); the package also exports the [session-index client](src/session-index-client.mjs) and [DSH source](src/session-index-dsh-source.mjs).

## Run and verify

The package manifest defines no project-specific install/bootstrap or `start` script. Use its declared tasks:

```sh
npm test                              # complete declared Node and end-to-end suite
npm run test:session-index-e2e        # session-index client end to end
npm run test:session-index-dsh-e2e    # DSH source end to end
npm run rust:fmt
npm run rust:clippy
npm run rust:test
npm run daemon:build
npm run daemon:test
```

The declared benchmarks are `npm run benchmark:session-history` and `npm run benchmark:session-history:scaled`. The package exposes `qq-index-refresh`, `qq-index-history-shadow`, and the safety-checking `qq-session-indexd-launch` supervisor through [`bin/`](bin/qq-session-indexd-launch).

The production session-index service is explicitly opt-in. Its exact plugin contract, bounded configuration, daemon build/user-unit installation, overrides, recovery behavior, and rollback procedure are documented in [`docs/session-index-production.md`](docs/session-index-production.md). The dedicated [`systemd/user/qq-session-indexd.service`](systemd/user/qq-session-indexd.service) does not replace the existing README refresh unit/timer.

## Repository map

- **Node package:** [`src/plugin.mjs`](src/plugin.mjs) is the main export. The other public exports are [`src/session-index-client.mjs`](src/session-index-client.mjs) and [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs). Frequently imported internal modules include [`src/harvest.mjs`](src/harvest.mjs), [`src/index.mjs`](src/index.mjs), [`src/model-pass.mjs`](src/model-pass.mjs), and [`src/refresh.mjs`](src/refresh.mjs).
- **Rust workspace:** [`Cargo.toml`](Cargo.toml) is the workspace root. The two crate boundaries are [`crates/session-index-core`](crates/session-index-core/Cargo.toml) and [`crates/session-indexd`](crates/session-indexd/Cargo.toml).
- **Operational entry points:** command wrappers are under [`bin/`](bin/qq-index-refresh). The README refresh user service/timer remain [`qq-index.service`](systemd/user/qq-index.service) and [`qq-index.timer`](systemd/user/qq-index.timer); the separately supervised daemon is [`qq-session-indexd.service`](systemd/user/qq-session-indexd.service).
- **Writer inputs:** start with [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml), and [`config/repositories`](config/repositories).

Because the package is ESM (`"type": "module"`), preserve ESM module conventions. Treat the `main`, `exports`, `bin`, and `scripts` fields in [`package.json`](package.json) as the authoritative package surface and task list.

## Change routing

| Change area | Start with | Relevant verification |
| --- | --- | --- |
| Plugin/package entry | [`src/plugin.mjs`](src/plugin.mjs), [`package.json`](package.json) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Index, harvest, or refresh | [`src/index.mjs`](src/index.mjs), [`src/harvest.mjs`](src/harvest.mjs), [`src/refresh.mjs`](src/refresh.mjs) | [`tests/index.mjs`](tests/index.mjs), [`tests/harvest.mjs`](tests/harvest.mjs), [`tests/refresh.mjs`](tests/refresh.mjs) |
| Writer boot/model pass | [`src/writer-boot.mjs`](src/writer-boot.mjs), [`src/model-pass.mjs`](src/model-pass.mjs) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs) |
| History shadow | [`src/history-shadow.mjs`](src/history-shadow.mjs), [`src/history-shadow-cli.mjs`](src/history-shadow-cli.mjs) | [`tests/history-shadow.mjs`](tests/history-shadow.mjs), [experiment notes](docs/history-shadow-experiment.md) |
| Session-index JS exports | [`src/session-index-client.mjs`](src/session-index-client.mjs), [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs) | [`tests/session-index-client.e2e.mjs`](tests/session-index-client.e2e.mjs), [`tests/session-index-dsh-source.e2e.mjs`](tests/session-index-dsh-source.e2e.mjs) |
| Rust core/search | [`crates/session-index-core/src/lib.rs`](crates/session-index-core/src/lib.rs), [`crates/session-index-core/src/search.rs`](crates/session-index-core/src/search.rs) | [`crates/session-index-core/tests/phase1a.rs`](crates/session-index-core/tests/phase1a.rs) |
| Rust daemon/protocol | [`crates/session-indexd/src/lib.rs`](crates/session-indexd/src/lib.rs), [`crates/session-indexd/src/protocol.rs`](crates/session-indexd/src/protocol.rs), [`crates/session-indexd/src/server.rs`](crates/session-indexd/src/server.rs) | [`crates/session-indexd/tests/daemon_protocol.rs`](crates/session-indexd/tests/daemon_protocol.rs) |

For the repository's session-history design detail, read [`docs/session-history-indexing.md`](docs/session-history-indexing.md).
