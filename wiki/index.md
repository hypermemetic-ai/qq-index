# qq-wiki orientation

Source and tests are authoritative. Route from here to the ownership boundary
needed for the job.

- [`convention.md`](convention.md) — read when changing what an orientation
  wiki means, how ownership boundaries split or merge, or the page/index form.
- [`writer.md`](writer.md) — read when changing replay behavior, edit limits,
  no-op rules, or how a repository's orientation is refreshed.
- [`loader.md`](loader.md) — read when changing index loading, caps, link
  validation, containment, exports, or loader tests.

Outbound joints:

- qq-workflows owns architect-time injection and audience selection; changes
  there should consume this package's bounded index loader.
