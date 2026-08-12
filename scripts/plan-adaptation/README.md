# Plan adaptation navigation map

`scripts/plan-adaptation.mjs` is the only command entry. It decodes the six lifecycle commands and
routes them directly to `plan-adaptation-lifecycle.mjs`.

- `adaptive-plan-record.mjs` owns the single fenced JSON record, canonical replacement, record
  validation, and record digest.
- `plan-change-facts.mjs` reads the actual Git diff and computes qualification, triggers,
  undeclared paths, and sorted path/mode/content digests.
- `adaptive-plan-policy.mjs` owns the five checkpoint judgments, two-slice horizon, and bounded
  consolidation rules.
- `active-plan-registry.mjs` reads active records and generates `plans/README.md`.
- `plan-adaptation-lifecycle.mjs` owns command side effects: plan writes, ignored drafts, read-only
  checks, final-evidence validation, and tactical-plan close-out.

The mirrored semantic tests are under `packages/tests/repo/plan-adaptation/` and run through
`npm run test:plan-adaptation`.
