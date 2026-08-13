# Plan adaptation navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/plan-adaptation.mjs",
    "symbol": "runCommand"
  },
  "results": [
    {
      "path": "scripts/plan-adaptation/plan-adaptation-lifecycle.mjs",
      "symbol": "writePlanAndRegistry"
    },
    {
      "path": "scripts/plan-adaptation/plan-adaptation-lifecycle.mjs",
      "symbol": "prepareAdaptivePlan"
    },
    {
      "path": "scripts/plan-adaptation/plan-adaptation-lifecycle.mjs",
      "symbol": "checkAdaptivePlans"
    },
    {
      "path": "scripts/plan-adaptation/plan-adaptation-lifecycle.mjs",
      "symbol": "closeAdaptivePlan"
    }
  ],
  "failures": [
    {
      "path": "scripts/plan-adaptation.mjs",
      "symbol": "toError"
    }
  ]
}
```

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
- `close` validates final PR evidence and the exact comparison-base plan, atomically writes a
  durable receipt while removing the tactical plan and registry entry, and exits through
  [plan-adaptation-lifecycle.mjs#closeAdaptivePlan](./plan-adaptation-lifecycle.mjs#closeAdaptivePlan).

- [adaptive-plan-record.mjs#parseAdaptivePlanRecord](./adaptive-plan-record.mjs#parseAdaptivePlanRecord)
  owns the single fenced JSON record, canonical replacement, non-capability record validation, and
  record digest.
- [adaptive-plan-capabilities.mjs#validateAdaptivePlanCapabilities](./adaptive-plan-capabilities.mjs#validateAdaptivePlanCapabilities)
  owns code and guidance declaration shapes, planned activation and topology reservation, and exact
  `contractPaths`/`factContracts` ownership policy.
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
- [plan-closure-receipt.mjs#createPlanClosureReceipt](./plan-closure-receipt.mjs#createPlanClosureReceipt)
  translates the validated close input into the canonical data-only receipt.
  [plan-closure-receipt.mjs#readAuthenticatedPlanClosureChanges](./plan-closure-receipt.mjs#readAuthenticatedPlanClosureChanges)
  verifies the base plan, generated base registry, receipt identity, and complete current-tree
  transition, and returns the exact authenticated base plan for read-only close-out consumers before
  qualification ignores the authenticated plan deletion.
- [plan-transition-authentication.mjs#readAuthenticatedPlanTransitionChanges](./plan-transition-authentication.mjs#readAuthenticatedPlanTransitionChanges)
  composes unchanged closure-v1 authentication with receipt-backed plan dispositions. Governance
  receipts are replayed structurally from their exact parent commit; historical trusted receipts
  require no current actor-permission lookup.
- [plan-adaptation-lifecycle.mjs#writePlanAndRegistry](./plan-adaptation-lifecycle.mjs#writePlanAndRegistry)
  is the common mutation exit for `init`, `complete-slice`, and `apply`. Destructive close calls
  `writeFileTransaction` directly after its separate final-evidence, comparison-base, registry,
  receipt, and target validation.

The mirrored semantic tests are under `packages/tests/repo/plan-adaptation/` and run through
`npm run test:plan-adaptation`.

## Exact non-code contracts

A code capability may declare an optional `contractPaths` array for exact repository files such as
pull-request templates, Markdown contracts, and workflow definitions. Each path is content-bound,
counts as declared changed surface, and participates in capability-crossing detection, but it is not
part of the capability's authored-code root, source-symbol evidence, or topology. Active paths must
resolve to non-code repository files. Planned paths reserve the same exact ownership before the file
exists, and code owners cannot claim the same path or claim a path inside another capability's owned
roots.

Guidance capabilities keep shared `contractPaths` semantics: those paths are evidence and may be
cited by more than one guidance owner. The backward-compatible skill form omits `guidanceRole` and
uses `skillRoot` plus its exact `skillEntry`. A first-class router instead declares
`guidanceRole: "router"` and one exact `routingEntry`; its normalized owner name mirrors the
contract-test root. Both forms declare a focused command and may declare evaluation evidence, but
their fields are an exact union so a router cannot masquerade as a skill owner. Router entries,
tests, evaluations, and contracts are content-bound without becoming authored-code topology or
source-symbol evidence.
