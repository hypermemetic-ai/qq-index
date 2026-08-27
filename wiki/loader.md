# Index loader and validation

## What it is

The loader is the bounded, dependency-free read boundary for a repository's
`wiki/index.md`. Validation proves that the index fits its context budget and
that every local page route resolves to a regular file physically contained in
`wiki/`.

## Sits with

- [Orientation convention](convention.md) defines why the cap and routing shape
  exist.
- [Writer replay](writer.md) produces indexes that satisfy this boundary.
- qq-workflows owns architect-only attach injection and the unattended refresh
  program; this repository supplies their loader and packet boundaries.

## Invariants

- `loadIndex(repoRoot)` returns an empty string when `wiki/` or its index is
  absent, and rejects an index over 10,000 Unicode code points.
- The cap is measured by iterating the decoded string. Multibyte and astral
  characters each count as one code point; bytes and physical lines are not
  separate limits.
- A `Refreshed: <ISO 8601 UTC>` line is ordinary index content and counts
  toward the same cap.
- `validateWiki(repoRoot)` accepts a completely absent wiki. A present wiki has
  an index and valid local routes.
- `wiki/`, its index, and linked pages cross the boundary only as real
  directories or regular files, not symbolic links or directories posing as
  pages.
- Relative routes cannot escape lexically, by URL encoding, or through a
  symbolic-link ancestor. URL and fragment-only destinations are not local
  page routes.

## Look in

- `src/index.mjs` — `loadIndex`, `validateWiki`, `INDEX_MAX_CHARS`, and
  containment.
- `tests/index.mjs` — missing, code-point cap, stamp, broken-link, escape, and
  real-wiki cases.
- `package.json` — public ESM export and test command.

## Traps

- JavaScript `String#length` counts UTF-16 code units, not Unicode code points.
- UTF-8 file size cannot stand in for a code-point prompt budget.
- A lexical `wiki/` prefix alone does not stop a link traversing a symbolic
  directory.
- A missing wiki is optional context; a malformed present wiki is not silently
  ignored by validation.
- Architect attach policy belongs to qq-workflows, not this loader.
