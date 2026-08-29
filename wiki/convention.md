# Orientation convention

## What it is

The repository convention defines an architect wiki as a routing aid from a
small always-present index to one ownership boundary. A page records the
invariants that must be considered together to plan, while source and tests
remain authoritative.

## Sits with

- [Writer replay](writer.md) applies this convention in another repository.
- [Index loader](loader.md) enforces the mechanical index boundary.
- qq-workflows owns architect index attachment and the Mini Docs adapter used
  by qq-wiki's inner writer pass. The workflow's Mini implementer and QA child
  remain non-injected audiences. This package owns the convention and outer
  publishing program; a timer invoking it is not a workflow.

## Invariants

- Pages follow ownership and shared invariants, not features, files, or
  directories.
- Independent topics split; topics that co-change to preserve shared invariants
  merge. A rare job alone does not justify a page.
- The index is the big-picture map. Its routes say both where and when to read.
- Normal planning fans out to one page, or two at a real joint. Three needs a
  specific justification; four means the map is too fine.
- Every page uses `What it is`, `Sits with`, `Invariants`, `Look in`, and
  `Traps`, and aims to remain within 150 lines.
- The index remains at most 10,000 Unicode code points. It has no byte or line
  cap.
- Every writer run places `Refreshed: <ISO 8601 UTC>` immediately after the
  index title. The stamp counts toward the code-point cap, and a stamp-only
  diff is a successful refresh.
- No wiki means no orientation context. Source wins every disagreement.

## Look in

- `README.md` — public convention.
- `tests/fixtures/qq-host-map.md` — scored seven-boundary example map.
- `tests/fixtures/architect-jobs.json` — historical route pressure.
- `tests/corpus.mjs` — fan-out and fixture drift assertions.

## Traps

- A directory map is not an ownership map.
- One page per historical job overfits the corpus and increases future fan-out.
- A broad overview page should not duplicate internals from every sibling.
- Signal files identify good re-entry points; they do not prove complete
  ownership or supersede source inspection.
- A UTF-16 string length or UTF-8 byte count is not a Unicode code-point count.
