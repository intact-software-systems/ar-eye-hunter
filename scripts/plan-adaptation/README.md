# Plan adaptation navigation map

[scripts/plan-adaptation.mjs#runCommand](../plan-adaptation.mjs#runCommand) is the only command
entry. It decodes six commands and routes each to its lifecycle owner:

- `init` refreshes facts through
  [plan-adaptation-lifecycle.mjs#initAdaptivePlan](./plan-adaptation-lifecycle.mjs#initAdaptivePlan).
- `complete-slice` advances the rolling horizon through
  [plan-adaptation-lifecycle.mjs#completeAdaptivePlanSlice](./plan-adaptation-lifecycle.mjs#completeAdaptivePlanSlice).
- `prepare` writes the ignored, content-bound judgment draft through
  [plan-adaptation-lifecycle.mjs#prepareAdaptivePlan](./plan-adaptation-lifecycle.mjs#prepareAdaptivePlan).
- `apply` validates and atomically installs that draft through
  [plan-adaptation-lifecycle.mjs#applyAdaptivePlan](./plan-adaptation-lifecycle.mjs#applyAdaptivePlan).
- `check` is read-only and exits through
  [plan-adaptation-lifecycle.mjs#checkAdaptivePlans](./plan-adaptation-lifecycle.mjs#checkAdaptivePlans).
- `close` validates final PR evidence, removes the tactical plan, and exits through
  [plan-adaptation-lifecycle.mjs#closeAdaptivePlan](./plan-adaptation-lifecycle.mjs#closeAdaptivePlan).

- [adaptive-plan-record.mjs#parseAdaptivePlanRecord](./adaptive-plan-record.mjs#parseAdaptivePlanRecord)
  owns the single fenced JSON record, canonical replacement, record validation, and record digest.
- [plan-change-facts.mjs#computePlanFacts](./plan-change-facts.mjs#computePlanFacts) reads the actual
  Git diff and computes qualification, triggers, undeclared paths, and sorted path/mode/content
  digests.
- [adaptive-plan-policy.mjs#validateCheckpoint](./adaptive-plan-policy.mjs#validateCheckpoint) owns
  the five checkpoint judgments, two-slice horizon, and bounded consolidation rules.
- [active-plan-registry.mjs#readActivePlans](./active-plan-registry.mjs#readActivePlans) reads active
  records and generates `plans/README.md`.
- [file-transaction.mjs#writeFileTransaction](./file-transaction.mjs#writeFileTransaction) stages
  same-directory replacements and rolls back multi-file lifecycle changes when any replacement
  fails.
- [plan-adaptation-lifecycle.mjs#writePlanAndRegistry](./plan-adaptation-lifecycle.mjs#writePlanAndRegistry)
  is the common mutation exit for `init`, `complete-slice`, and `apply`. Destructive close calls
  `writeFileTransaction` directly after its separate final-evidence, registry, and target
  validation.

The mirrored semantic tests are under `packages/tests/repo/plan-adaptation/` and run through
`npm run test:plan-adaptation`.
