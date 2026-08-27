# Orientation convention

## What it is

The repository convention defines an architect wiki as a routing aid from a
small always-present index to one ownership boundary. A page records the
invariants that must be considered together to plan, while source and tests
remain authoritative.

## Sits with

- [Writer replay](writer.md) applies this convention in another repository.
- [Index loader](loader.md) enforces the mechanical index boundary.
- qq-workflows is the outbound consumer that decides when architect context is
  attached.

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
- The index remains at most 4 KiB and 80 lines. No wiki means no orientation
  context. Source wins every disagreement.

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
