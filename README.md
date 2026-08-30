# qq-index

`@hypermemetic-ai/qq-index` is a private ECMAScript-module package whose declared purpose is **bounded repository orientation in `README.md`**. Its package entry and root export are both [`src/plugin.mjs`](src/plugin.mjs); [`package.json`](package.json) is authoritative for the package surface and scripts.

## Run and verify

```sh
npm test
npm run benchmark:session-history
npm run benchmark:session-history:scaled
```

`npm test` is the only declared test script and runs the Node-based suite across the plugin, index, harvest, history-shadow, session-history benchmark, writer-boot, and refresh paths. Both benchmark tasks invoke [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py) with Python 3; the scaled task adds `--mode scaled`.

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

[`src/harvest.mjs`](src/harvest.mjs) has the highest recorded relative-module fan-in (four distinct tracked importers), so changes there merit the full test suite. Beyond the package and executable mappings above, file names alone do not establish runtime wiring; confirm imports before treating similarly named files as a pipeline.

## Existing operational detail

- Session-history design and experiment notes: [`docs/session-history-indexing.md`](docs/session-history-indexing.md) and [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md).
- Repository and writer configuration: [`config/repositories`](config/repositories) and [`config/writer.patch.yml`](config/writer.patch.yml).
- Tracked systemd user units: [`systemd/user/qq-index.service`](systemd/user/qq-index.service) and [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer). No enable/start procedure is declared in the package scripts.
