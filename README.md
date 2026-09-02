# qq-index

`@hypermemetic-ai/qq-index` is a private ESM package for **bounded repository orientation in `README.md`**. Its default package entry and root export are [`src/plugin.mjs`](src/plugin.mjs); the package also exposes explicit session-index client, source, runtime, and launcher modules.

## Start here

Install the declared dependency and run the complete package test command:

```sh
npm install
npm test
```

`npm test` runs the Node test suite followed by both declared session-index end-to-end scripts. There is no `start` script. The package instead declares three executable entry points; their wrappers are the authoritative place to check invocation details:

- `qq-index-refresh` — [`bin/qq-index-refresh`](bin/qq-index-refresh)
- `qq-index-history-shadow` — [`bin/qq-index-history-shadow`](bin/qq-index-history-shadow)
- `qq-session-indexd-launch` — [`bin/qq-session-indexd-launch`](bin/qq-session-indexd-launch)

Useful focused commands:

| Task | Command |
| --- | --- |
| Session-index client E2E | `npm run test:session-index-e2e` |
| DSH source E2E | `npm run test:session-index-dsh-e2e` |
| Build or test the daemon | `npm run daemon:build` / `npm run daemon:test` |
| Check the Rust workspace | `npm run rust:fmt` / `npm run rust:clippy` / `npm run rust:test` |
| Run the session-history benchmark | `npm run benchmark:session-history` |
| Run its scaled mode | `npm run benchmark:session-history:scaled` |

## Repository map

- **Public JavaScript surface:** [`src/plugin.mjs`](src/plugin.mjs) plus the exported [`client`](src/session-index-client.mjs), [`DSH source`](src/session-index-dsh-source.mjs), [`runtime`](src/session-index-runtime.mjs), and [`launcher`](src/session-index-launcher.mjs) modules.
- **Internal JavaScript coordination:** [`src/harvest.mjs`](src/harvest.mjs), [`src/index.mjs`](src/index.mjs), [`src/model-pass.mjs`](src/model-pass.mjs), and [`src/refresh.mjs`](src/refresh.mjs) are the principal fan-in and frequently changed routing points.
- **Rust workspace:** [`Cargo.toml`](Cargo.toml) joins the [`session-index-core`](crates/session-index-core/src/lib.rs) library and the [`qq-session-indexd`](crates/session-indexd/src/main.rs) daemon package.
- **Writer inputs and launch configuration:** [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml), [`config/repositories`](config/repositories), and the [`systemd/user`](systemd/user/qq-index.service) units are distinct configuration boundaries.

The JavaScript and Rust checks are separate: the package's `npm test` script does not include the declared Cargo formatting, linting, or test scripts.

## Route common changes

| Change | Begin with | Verify or read next |
| --- | --- | --- |
| Root plugin/package integration | [`src/plugin.mjs`](src/plugin.mjs), [`package.json`](package.json) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Session-index runtime or launcher | [`src/session-index-runtime.mjs`](src/session-index-runtime.mjs), [`src/session-index-launcher.mjs`](src/session-index-launcher.mjs) | [`tests/session-index-runtime.mjs`](tests/session-index-runtime.mjs), [`tests/session-index-capabilities.mjs`](tests/session-index-capabilities.mjs), [`tests/session-index-launcher.mjs`](tests/session-index-launcher.mjs) |
| Session-index client or DSH source | [`src/session-index-client.mjs`](src/session-index-client.mjs), [`src/session-index-dsh-source.mjs`](src/session-index-dsh-source.mjs) | [`tests/session-index-client.e2e.mjs`](tests/session-index-client.e2e.mjs), [`tests/session-index-dsh-source.e2e.mjs`](tests/session-index-dsh-source.e2e.mjs), [`tests/session-index-dsh-production.mjs`](tests/session-index-dsh-production.mjs) |
| Rust search or daemon protocol | [`crates/session-index-core/src/search.rs`](crates/session-index-core/src/search.rs), [`crates/session-indexd/src/protocol.rs`](crates/session-indexd/src/protocol.rs), [`crates/session-indexd/src/server.rs`](crates/session-indexd/src/server.rs) | [`crates/session-index-core/tests/phase1a.rs`](crates/session-index-core/tests/phase1a.rs), [`crates/session-indexd/tests/daemon_protocol.rs`](crates/session-indexd/tests/daemon_protocol.rs) |
| Orientation/writer flow | [`src/model-pass.mjs`](src/model-pass.mjs), [`src/writer-boot.mjs`](src/writer-boot.mjs), [`prompts/writer.md`](prompts/writer.md) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs), [`tests/refresh.mjs`](tests/refresh.mjs), [`tests/index.mjs`](tests/index.mjs) |

## Existing detail

Use the focused repository notes rather than expanding this index: [session-history indexing](docs/session-history-indexing.md), [session-index production](docs/session-index-production.md), and the [history-shadow experiment](docs/history-shadow-experiment.md).
