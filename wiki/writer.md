# Writer replay

## What it is

The frozen writer packet refreshes a repository's architect orientation from
current source and tests. It is a constrained maintenance pass, not a request
to document everything.

## Sits with

- [Orientation convention](convention.md) supplies the boundary and fan-out
  rules the packet applies.
- [Index loader](loader.md) supplies mechanical limits the resulting index must
  satisfy.
- The packet is repository-neutral; the target repository owns the resulting
  `wiki/` content.

## Invariants

- The writer discovers semantic ownership before choosing page boundaries and
  never mirrors the source tree by default.
- Only stale orientation changes. An accurate wiki produces no diff.
- Wrong pages are deleted rather than padded, preserved for history, or filled
  with invented claims.
- Every semantic assertion is grounded in source or tests.
- The writer touches only `wiki/`, including when restructuring pages.
- The output preserves the required headings, index caps, and one-to-two-page
  normal route.

## Look in

- `prompts/writer.md` — the replay packet and edit boundary.
- `README.md` — the convention the packet must preserve.
- `wiki/convention.md` — local planning orientation for page rules.
- `tests/corpus.mjs` — pressure against encyclopedia drift.

## Traps

- Updating package metadata or source while “helpfully” refreshing the wiki
  violates the replay boundary.
- Keeping a stale page with disclaimers is worse than deleting it.
- Inventing an invariant to make a sparse page look useful corrupts future
  plans.
- An empty diff is a successful replay when source has not falsified the map.
