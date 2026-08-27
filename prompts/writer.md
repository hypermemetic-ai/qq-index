# Architect orientation wiki writer

Work in the supplied Git repository. Produce only durable architect
orientation grounded in current source and tests.

## Execution contract

Run this packet as `gpt-5.6-sol` with `xhigh` reasoning. Allow only `read`,
`grep`, `glob`, `bash`, `edit`, and `write`. Deny `land`, `delegate`, `relay`,
web, browser, skills or skill-catalog tools, and harness tools. Do not commit or
push.

Use `read`, `grep`, and `glob` as the primary discovery interface. Use `bash`
only for focused `git log` or `git diff` inspection and to run validation; do
not use it to dump the tree or as a substitute for reading evidence. Writes
are allowed only under `wiki/`.

The current `wiki/index.md` may already be in system context because the
wiki-writer is an index audience. It is a routing hint, not authority: it may
be stale, source and tests win, and wrong pages may be deleted. A missing wiki
is valid and supplies no existing hint.

## Forced phases

Follow this order. Do not write any page until the ownership boundaries have
been named.

1. **Map (read-only).** Inspect enough current source, tests, and recent history
   to identify clusters whose invariants must travel together. Do not mirror
   directories, enumerate the tree, or turn features and files into pages.
2. **Split or merge.** Treat one page as one ownership boundary whose invariants
   must be held together to plan. Split topics that change independently and
   share no invariants. Merge topics when changing one almost always requires
   the other's invariants, or when a dedicated page would serve one rare job.
   Optimize for one page besides the index; use two only for a real joint.
   Three requires an explicit reason. Never design for four or more.
3. **Write or page-no-op.** On first generation, create `wiki/` only from the
   evidence collected above. On refresh, change only stale orientation and
   delete wrong pages. If existing pages are accurate, leave their content
   unchanged. Do not invent semantics, invariants, symbols, or relationships.
4. **Stamp.** Always set `Refreshed: <ISO 8601 UTC>` on `wiki/index.md`
   immediately after its title, including when no page content changed. The
   line counts toward the 10,000 Unicode-code-point index cap. A stamp-only
   diff is a successful refresh.
5. **Mechanical check.** Run `validateWiki(repoRoot)`. Inspect the final diff
   and require it to contain only regular files under `wiki/`. Any write
   elsewhere fails the run. Do not commit or push.

Discard scratch notes; they are not pages.

## Index and page form

Make `wiki/index.md` the big-picture routing table. Each entry is a relative
page path plus a short statement of when to read it. Keep sibling-repository
and other outbound joints as one-line index routes and brief “Sits with” notes,
not a global encyclopedia. Keep the complete index, including its stamp, at or
below 10,000 Unicode code points. There is no byte or line cap.

Keep each page scannable, aiming for at most 150 lines, with exactly this
heading skeleton:

- `## What it is` — semantics and ownership, not a file list
- `## Sits with` — required joints, sibling repositories, and other pages
- `## Invariants` — constraints a plan must preserve
- `## Look in` — selective paths, symbols, and tests that re-establish truth
- `## Traps` — lookalikes, stale assumptions, and tempting wrong routes

## Edit boundary

Touch only `wiki/`. Do not edit application code, tests, package metadata,
prompts, repository instructions, or files elsewhere. A missing wiki is valid
before first generation. Finish with a wiki-only diff; unchanged page content
plus the required stamp update is a successful no-op refresh.
