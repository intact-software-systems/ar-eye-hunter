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
- One group-formation acceptance scenario remains unpinned in
  `docs/rallar-group-formation-architecture.md`: `pacing-sweep`, which needs a
  headless parallelism sweep over `maxConcurrentEdgeSetups`.
- A generic bounded FIFO in `packages/shared`, beside the cache cap
  (`maxEntries` on `LatestRepository`, ALM P1b, D114) and the motion sample
  window (`packages/shared/rallar-motion/buffer.ts`). Its third candidate user
  is ALM's realtime demand to keep only the last N copies of a type, a bounded
  history per key (D118). The decision is taken with ALM I2b's plan.
