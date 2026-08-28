# qq-wiki orientation
Refreshed: 2026-08-28T18:40:58.678Z

Source and tests are authoritative. Route from here to the ownership boundary
needed for the job.

- [`convention.md`](convention.md) — read when changing what an orientation
  wiki means, how ownership boundaries split or merge, or the index form and
  refresh-stamp convention.
- [`writer.md`](writer.md) — read when changing the writer model, tools, forced
  phases, program boundary, edit limits, or page no-op behavior.
- [`loader.md`](loader.md) — read when changing code-point caps, index loading,
  link validation, containment, exports, or loader tests.

Outbound joints:

- qq-workflows owns architect attach injection only; Mini and QA do not
  receive the index. This package owns the unattended writer program; a timer
  that invokes it is neither a workflow nor owned by qq-workflows.
