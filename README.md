# qq-wiki

A repository may keep an architect orientation wiki in `wiki/`. Its
`wiki/index.md` is a small routing table that tells an architect which page to
read for a job. Source and tests remain authoritative; the wiki only shortens
the route to them.

A page describes one **ownership boundary whose invariants must be held
together to plan**. It is not one page per feature, file, or directory.

- Split topics that change independently and do not share invariants.
- Merge topics when changing one usually requires the other's invariants, or
  when a separate page would serve only one rare job.
- Put the big picture in the index. Keep outbound sibling joints to one-line
  routes there and a short “Sits with” pointer on the relevant page.
- A typical job should need one page besides the index, or two for a real
  ownership joint. Three needs explicit justification. Do not design routes
  that normally require four or more pages.
- Prefer deleting a wrong page to preserving or padding it.

Every page uses these headings and stays scannable (aim for at most 150 lines):

1. What it is
2. Sits with
3. Invariants
4. Look in
5. Traps

`wiki/index.md` is capped at 10,000 Unicode code points. Each index entry is a
path plus when to read it. A writer refresh always puts
`Refreshed: <ISO 8601 UTC>` immediately after the index title; that line counts
toward the cap. A missing wiki contributes no context. When the wiki and the
repository disagree, source wins.

`prompts/writer.md` is the frozen writer packet. qq-workflows owns index
injection and the three-times-daily refresh runner: architect and wiki-writer
sessions receive the index, while Mini and QA sessions do not. This package
owns the loader, validation, convention, and packet; each repository owns its
own `wiki/` content.
