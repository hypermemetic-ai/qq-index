# qq-wiki orientation
Refreshed: 2026-08-29T01:18:23.669Z

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

- qq-workflows owns architect index attachment and the Mini Docs adapter used
  by qq-wiki's inner writer pass. Workflow Mini implementer and QA children
  still do not receive the index. qq-wiki still owns outer publication; its
  direct timer is not a workflow.
