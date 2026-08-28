# Writer replay

## What it is

The frozen writer packet refreshes a repository's architect orientation from
current source and tests. It is a read-heavy ownership-discovery pass for
`gpt-5.6-sol` at `xhigh`, not a request to document everything.

## Sits with

- [Orientation convention](convention.md) supplies the boundary and fan-out
  rules the packet applies.
- [Index loader](loader.md) supplies mechanical limits the resulting index must
  satisfy.
- The packet is repository-neutral; the target repository owns the resulting
  `wiki/` content.
- This package owns the unattended writer program: isolated worktree,
  optional model pass, validation, path check, and mechanical wiki commit.
- qq-workflows owns architect attach injection only; Mini and QA do not receive
  the index, and the writer is not an injection audience. A timer that invokes
  the program is neither a workflow nor owned by qq-workflows.

## Invariants

- Mapping is read-only and comes first. Source, tests, and focused history name
  semantic ownership before any page is written or split.
- The inner model pass reads `wiki/index.md` from the target tree when it
  exists and treats it only as a potentially stale hint. Source wins, and wrong
  pages are deleted rather than padded, preserved for history, or filled with
  invented claims.
- Accurate page content produces no page diff, but every run sets
  `Refreshed: <ISO 8601 UTC>` immediately after the index title. A stamp-only
  diff is success.
- The stamp counts toward the 10,000 Unicode-code-point index cap.
- The inner model pass writes only under `wiki/` and never commits or pushes.
  The wrapping program publishes mechanically only after `validateWiki` and a
  wiki-only regular-file path check pass.
- Native `read`, `grep`, and `glob` are the discovery interface. `bash` is for
  focused history, diff, and validation; edit and write stay under `wiki/`.
- The writer is an unattended program, not a session or workflow step; an
  operator neither triggers it nor waits for it.
- The output preserves the required headings and one-to-two-page normal route.

## Look in

- `prompts/writer.md` — model, tools, forced phases, stamp, and edit boundary.
- `src/model-pass.mjs` and `config/writer.patch.yml` — exact headless DSH plan,
  model binding, tool boundary, and qq-models resolution.
- `src/refresh.mjs` and `bin/qq-wiki-refresh` — lock, isolated clone, path
  checks, bot commit, fast-forward publication, registry entry point.
- `tests/refresh.mjs` — temporary-Git coverage for both paths and failure
  fences.
- `README.md` — the convention the packet must preserve.
- `wiki/convention.md` — local planning orientation for page rules.
- `tests/index.mjs` — mechanical stamp and cap coverage.
- `tests/corpus.mjs` — pressure against encyclopedia drift.

## Traps

- Reading the tree and summarizing it is not ownership discovery.
- Updating package metadata or source while “helpfully” refreshing the wiki
  violates the replay boundary.
- Keeping a stale page with disclaimers is worse than deleting it.
- Inventing an invariant to make a sparse page look useful corrupts future
  plans.
- Page no-op does not skip the required refresh stamp.
- DSH imports plugin `name` before evaluating `!!js`. The wrapper inlines a
  `file:` URL to `qq-models/src/plugin.mjs`; do not put `!!js` on `name`.
