# qq-index

`@hypermemetic-ai/qq-index` keeps repository orientation at the conventional
entry point: root `README.md`. The authored README is a compact editorial
product for GitHub, npm, and contributors. `loadIndex` returns it unchanged when
it fits the injection budget and otherwise returns a deterministic Markdown
excerpt with a truncation marker and a route back to the full document.

## Run and test

```bash
npm test
bin/qq-index-refresh --repo /path/to/repository
```

Without `--repo`, the refresh CLI reads [`config/repositories`](config/repositories)
and processes that bounded registry at concurrency three. The packaged oneshot
and schedule are [`systemd/user/qq-index.service`](systemd/user/qq-index.service)
and [`systemd/user/qq-index.timer`](systemd/user/qq-index.timer); the service
expects this checkout at `%h/projects/qq-index`.

## System map

- [`src/plugin.mjs`](src/plugin.mjs) is the Cordis entry point and provides the
  frozen `qq-index` service.
- [`src/index.mjs`](src/index.mjs) owns full-document link validation and the
  separate bounded `loadIndex` projection.
- [`src/harvest.mjs`](src/harvest.mjs) builds deterministic writer evidence from
  package metadata, tracked paths, change heat, and relative-import fan-in.
- [`prompts/writer.md`](prompts/writer.md),
  [`src/model-pass.mjs`](src/model-pass.mjs), and
  [`src/writer-boot.mjs`](src/writer-boot.mjs) define and launch the constrained
  headless README writer.
- [`src/refresh.mjs`](src/refresh.mjs) isolates, validates, commits, and
  fast-forwards an accepted README-only result; [`src/cli.mjs`](src/cli.mjs)
  selects repositories and bounds parallel refreshes.

## Contributor invariants

- The complete authored README is valid independently of injection size. Every
  local link and image must resolve to a regular file inside the repository;
  external URLs and in-document fragments are ignored.
- Injected output has a total 10,000-Unicode-code-point failsafe, including its
  marker and full-README route. Oversize readable content degrades to a useful
  excerpt; size alone is not a validation error.
- The writer treats the evidence packet as its only repository evidence and may
  replace only `README.md`. Package metadata can establish commands; path heat
  and fan-in can support routing, but path names do not prove behavior.
- Refresh runs under a per-repository lock in an isolated clean `main` clone,
  rejects non-README changes, validates before commit, and publishes only when
  live `main` can still fast-forward from the captured revision.

## Change routing

- Injection budget, Markdown projection, or link policy:
  [`src/index.mjs`](src/index.mjs) and [`tests/index.mjs`](tests/index.mjs).
- Evidence shape, path ranking, or import resolution:
  [`src/harvest.mjs`](src/harvest.mjs) and
  [`tests/harvest.mjs`](tests/harvest.mjs).
- Writer contract or model launch: [`prompts/writer.md`](prompts/writer.md),
  [`src/model-pass.mjs`](src/model-pass.mjs), and
  [`tests/refresh.mjs`](tests/refresh.mjs).
- Mini Docs mounting: [`src/writer-boot.mjs`](src/writer-boot.mjs) and
  [`tests/writer-boot.mjs`](tests/writer-boot.mjs).
- Locking, Git boundaries, validation timing, or publication:
  [`src/refresh.mjs`](src/refresh.mjs) and
  [`tests/refresh.mjs`](tests/refresh.mjs).
- Registry parsing or bounded concurrency: [`src/cli.mjs`](src/cli.mjs) with CLI
  coverage in [`tests/refresh.mjs`](tests/refresh.mjs).
