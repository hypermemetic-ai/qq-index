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

`prompts/writer.md` is the frozen bash-only writer packet. The inner headless
pass loads qq-workflows' `qq-mini-docs` adapter, while a tiny qq-wiki boot plugin
mounts that adapter on the headerless agent created by the headless runner. Mini
Docs supplies the bounded observation window, bash wrapper, format retry, and
exact completion sentinel. The inner pass never commits or invokes Land.

That writer pass is not the Mini implementer or QA child in an operator
workflow. qq-workflows also owns architect index attachment, but the attachment
audience remains the architect: Mini implementer and QA children still do not
receive the index.

This package owns the loader, validation, convention, packet, writer boot, and
outer refresh program. The outer program runs the model in an isolated
worktree, validates the result, checks the wiki-only path boundary, and still
commits and publishes mechanically. Each repository owns its own `wiki/`
content.

The refresh program lives in `src/refresh.mjs` and `bin/qq-wiki-refresh`;
`src/model-pass.mjs` resolves both qq-models and qq-workflows and spawns DSH with
the package-owned `config/writer.patch.yml`. `config/repositories` is the
bounded first-wave registry. The shipped user timer invokes the program
directly: the timer is not an operator workflow and is not owned by
qq-workflows. Tests use temporary repositories and stub the model pass in
`tests/refresh.mjs`.
