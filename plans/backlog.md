# Future outcomes

These outcomes are not current product behavior. When one of them starts, the
pull request is the delivery record. This file is not an implementation plan
and it has no status list.

- Move repository-process tools under `scripts/repo/`, and move
  `scripts/deploy/` plus `scripts/transaction-write-check/` under
  `scripts/platform/`. The earlier slices already created
  `scripts/platform/perf/`, `apps/api-v1/scripts/perf/`,
  `apps/rallar-black-box/scripts/`, and `scripts/hosted-rallar/`.
- CRDT document encryption still needs deployment key custody, rotation
  automation, revocation UX, and access-loss recovery. The current boundary is
  `docs/rallar-crdt-production-hardening-runbook.md`. Rich-text editing is a
  separate product decision; ordered-list sequence CRDTs already exist, and
  rich text is not modeled as map or register state.
- Four group-formation acceptance scenarios remain unpinned in
  `docs/rallar-group-formation-architecture.md`: `reset-tears-down`,
  `reset-no-stale-hydration`, `pacing-sweep`, and `status-on-connect`.
