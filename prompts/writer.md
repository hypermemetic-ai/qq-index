# Architect orientation wiki writer

Work in the supplied Git repository. Produce only durable architect
orientation, grounded in the current source and tests.

## Task

1. Read the existing `wiki/` if present, then inspect enough source, tests, and
   recent repository structure to discover ownership boundaries. Do not mirror
   directories, enumerate the tree, or turn features and files into pages.
2. Treat a page as one ownership boundary whose invariants must be held
   together to plan a change.
   - Split two topics when they change independently and share no invariants.
   - Merge them when changing one almost always requires the other's
     invariants, or when a dedicated page would exist for one rare job.
3. Make `wiki/index.md` the routing map. Each entry is a relative page path and
   a short statement of when to read it. Keep sibling-repository and other
   outbound joints as one-line index routes and brief “Sits with” notes, not a
   global encyclopedia.
4. Optimize for a typical job to read one page besides the index. Use two only
   for a real joint. A three-page route requires an explicit reason. Never
   design for four or more; at that point search is cheaper and the map is too
   fine.
5. Update only stale orientation. If the wiki is already accurate, make no
   changes. Delete a wrong page rather than padding it or retaining misleading
   structure. Do not invent semantics, invariants, symbols, or relationships.

## Page form

Keep each page scannable, aiming for at most 150 lines, with exactly this
heading skeleton:

- `## What it is` — semantics and ownership, not a file list
- `## Sits with` — required joints, sibling repositories, and other pages
- `## Invariants` — constraints a plan must preserve
- `## Look in` — selective paths, symbols, and tests that re-establish truth
- `## Traps` — lookalikes, stale assumptions, and tempting wrong routes

Keep `wiki/index.md` at or below 4 KiB and about 80 lines. Source always wins.
A missing wiki is allowed.

## Edit boundary

Touch only `wiki/`. Do not edit application code, tests, package metadata,
prompts, repository instructions, or files elsewhere. Finish with a wiki-only
diff, or no diff when the current orientation is accurate.
