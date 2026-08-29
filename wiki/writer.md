# Writer replay

## What it is

The frozen writer packet refreshes a repository's architect orientation from
current source and tests. It is a bash-only ownership-discovery pass for
`gpt-5.6-sol` at `xhigh`, not a request to document everything. qq-workflows'
Mini Docs adapter controls the inner pass; qq-wiki controls the outer refresh
and publication boundary.

## Sits with

- [Orientation convention](convention.md) supplies the boundary and fan-out
  rules the packet applies.
- [Index loader](loader.md) supplies mechanical limits the resulting index must
  satisfy.
- The target repository owns the resulting `wiki/` content.
- qq-workflows owns the `qq-mini-docs` inner adapter as well as architect index
  attachment. The local writer boot mounts that adapter on every headless
  agent because the runner creates one with only `meta.cwd`.
- This package owns the isolated worktree, writer boot, validation, path check,
  mechanical wiki commit, and publication.
- The headless writer is not the workflow's Mini implementer or QA child. Those
  children still do not receive the index. A timer invoking qq-wiki directly
  is not a workflow and is not owned by qq-workflows.

## Invariants

- Mapping is read-only and comes first. Source, tests, and focused history name
  semantic ownership before any page is written or split.
- The inner model pass discovers `wiki/index.md` from the target tree when it
  exists and treats it only as a potentially stale hint. Source wins, and wrong
  pages are deleted rather than padded, preserved for history, or filled with
  invented claims.
- Accurate page content produces no page diff, but every run sets
  `Refreshed: <ISO 8601 UTC>` immediately after the index title. A stamp-only
  diff is success, and the stamp counts toward the 10,000-code-point cap.
- The overlay keeps native bash, disables `tool-fs` and `tool-fs-search`, uses
  `approval: never`, and may retain workspace-write sandboxing. Mini Docs then
  restricts the model catalog to its wrapped `{ command }` bash tool.
- Every model response calls bash. Focused commands account for Mini's bounded
  observation window; discovery and writes both happen through bash.
- The local boot calls `miniDocsSetup(agentCtx, { env })` for every live and new
  agent without relying on `kind` or `agentPreset`. Mini Docs remains the sole
  owner of bash wrapping, format retry, and completion interception.
- After `validateWiki(repoRoot)` and a wiki-only regular-file diff, the inner
  pass calls exactly `echo COMPLETE_DOCS_AND_EXIT`. The sentinel concludes the
  turn successfully without commit, Land, or publication.
- The inner pass writes only under `wiki/` and never commits or pushes. The
  outer qq-wiki program still publishes mechanically after all checks pass.
- The writer is a headless program, not a session or workflow step. The output
  preserves the required headings and one-to-two-page normal route.

## Look in

- `prompts/writer.md` — model, bash-only contract, forced phases, sentinel,
  stamp, and edit boundary.
- `config/writer.patch.yml` — filesystem disables and the three inserted plugin
  tokens.
- `src/model-pass.mjs` — qq-models/qq-workflows resolution, file-URL inlining,
  model binding, and headless spawn.
- `src/writer-boot.mjs` — unconditional live/new-agent Mini Docs mounting.
- `src/refresh.mjs` and `bin/qq-wiki-refresh` — lock, isolated clone, path
  checks, bot commit, fast-forward publication, and registry entry point.
- `tests/writer-boot.mjs` and `tests/refresh.mjs` — headerless mounting, overlay,
  packet, temporary-Git paths, and failure fences.
- `wiki/convention.md` and `tests/corpus.mjs` — page rules and pressure against
  encyclopedia drift.
- `tests/index.mjs` — mechanical stamp and cap coverage.

## Traps

- Reading the tree and summarizing it is not ownership discovery.
- Updating source while “helpfully” refreshing the wiki violates the replay
  boundary; the inner pass must not commit even though the outer program does.
- Keeping a stale page with disclaimers is worse than deleting it.
- Inventing an invariant to make a sparse page look useful corrupts future
  plans. Page no-op still requires the refresh stamp.
- Loading `qq-mini-docs` alone is insufficient: its own `apply()` filters on
  `kind`/`agentPreset`, while the headless runner supplies only `meta.cwd`.
- Do not copy `wrapMiniBash` into qq-wiki or replace `headless-runner`; the boot
  exists only to call the exported Mini Docs mount API.
- DSH imports every plugin `name` before evaluating `!!js`. Model-pass must
  inline `file:` URLs for qq-models, qq-mini-docs, and writer boot.
- Do not confuse this pass with a workflow Mini implementer/QA child or inject
  the index into those children.
