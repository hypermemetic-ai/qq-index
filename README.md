# qq-index

`@hypermemetic-ai/qq-index` is a private ESM package for **bounded repository orientation in `README.md`**. Its package-level main entry point and only export are [`src/plugin.mjs`](src/plugin.mjs); it also declares [`qq-index-refresh`](bin/qq-index-refresh) and the shadow-only [`qq-index-history-shadow`](bin/qq-index-history-shadow) executables. See [`package.json`](package.json) for the authoritative package surface.

## Commands

Run the complete test suite:

```sh
npm test
```

It runs the plugin, index, harvest, history-shadow, synthetic session-history benchmark, writer-boot, and refresh test scripts in that order. The benchmark test requires Python 3 with a standard-library SQLite build that includes FTS5.

Run the reproducible storage-shape microbenchmark separately:

```sh
npm run benchmark:session-history
npm run benchmark:session-history:scaled  # explicit 250,000-document mode
```

The small default generates 16,000 documents. Both modes accept only generated fixture controls, create a new database under a temporary directory, emit methodology/percentiles and transaction/WAL assertions as JSON, and delete the fixture. They accept no database, corpus, session, query, or output path and must never be pointed at real session data. Results are observations, not automatic SLO passes; see [`docs/session-history-indexing.md`](docs/session-history-indexing.md) for the engine decision, API/lifecycle contract, limitations, and performance gates.

No install or start script is declared. The package metadata establishes the `qq-index-refresh` production executable and the developer-only `qq-index-history-shadow` analyzer. The analyzer emits local, unpublished JSON for one `--repo` or the configured registry; its frozen units, limits, selectors, and evaluation gate are in [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md).

## Repository map

- **Package boundary:** [`src/plugin.mjs`](src/plugin.mjs) is the exported module; production refresh and developer shadow analysis use separate [`qq-index-refresh`](bin/qq-index-refresh) and [`qq-index-history-shadow`](bin/qq-index-history-shadow) executables.
- **Central source modules:** [`src/harvest.mjs`](src/harvest.mjs) owns production evidence; [`src/history-shadow.mjs`](src/history-shadow.mjs) is an isolated, unpublished history experiment. [`src/index.mjs`](src/index.mjs), [`src/model-pass.mjs`](src/model-pass.mjs), and [`src/refresh.mjs`](src/refresh.mjs) remain production boundaries.
- **Session-history design evidence:** [`docs/session-history-indexing.md`](docs/session-history-indexing.md) records the accepted Turso engine decision and policy-neutral mature-SQLite service contract. [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py) is generated-data-only and is not a production engine.
- **Writer and repository inputs:** writer-named assets live in [`prompts/writer.md`](prompts/writer.md), [`config/writer.patch.yml`](config/writer.patch.yml), and [`src/writer-boot.mjs`](src/writer-boot.mjs); repository configuration is tracked in [`config/repositories`](config/repositories).
- **User service files:** the tracked unit and schedule are [`systemd/user/qq-index.service`](systemd/user/qq-index.service) and [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer).

## Route a change

| Change area | Start with | Focused test |
| --- | --- | --- |
| Package export or plugin | [`package.json`](package.json), [`src/plugin.mjs`](src/plugin.mjs) | [`tests/plugin.mjs`](tests/plugin.mjs) |
| Index-named module | [`src/index.mjs`](src/index.mjs) | [`tests/index.mjs`](tests/index.mjs) |
| Harvest-named module | [`src/harvest.mjs`](src/harvest.mjs) | [`tests/harvest.mjs`](tests/harvest.mjs) |
| History shadow experiment | [`docs/history-shadow-experiment.md`](docs/history-shadow-experiment.md), [`src/history-shadow.mjs`](src/history-shadow.mjs) | [`tests/history-shadow.mjs`](tests/history-shadow.mjs) |
| Session-history engine/API or synthetic benchmark | [`docs/session-history-indexing.md`](docs/session-history-indexing.md), [`benchmarks/session_history_fts5.py`](benchmarks/session_history_fts5.py) | [`tests/session-history-benchmark.mjs`](tests/session-history-benchmark.mjs) |
| Writer bootstrap | [`src/writer-boot.mjs`](src/writer-boot.mjs) | [`tests/writer-boot.mjs`](tests/writer-boot.mjs) |
| Refresh-named module | [`src/refresh.mjs`](src/refresh.mjs) | [`tests/refresh.mjs`](tests/refresh.mjs) |

Run `npm test` after a focused check. The tracked paths do not establish direct test coverage for prompt, configuration, model-pass, executable, or systemd-file changes, so use the full declared suite and review the affected boundary explicitly.
