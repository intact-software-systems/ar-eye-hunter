# Distributed validation risk navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/distributed-validation-risk.mjs",
    "symbol": "runDistributedValidationRiskCommand"
  },
  "results": [
    {
      "path": "scripts/distributed-validation-risk/distributed-validation-risk.mjs",
      "symbol": "classifyDistributedValidationRisk"
    },
    {
      "path": "scripts/distributed-validation-risk/distributed-validation-result.mjs",
      "symbol": "validateDistributedValidationResult"
    }
  ],
  "failures": [
    {
      "path": "scripts/distributed-validation-risk.mjs",
      "symbol": "toError"
    }
  ]
}
```

[scripts/distributed-validation-risk.mjs#runDistributedValidationRiskCommand](../distributed-validation-risk.mjs#runDistributedValidationRiskCommand)
is the only command entry. It exposes two direct operations:

- `select` reads the exact Git range and any active adaptive-plan record, then calls
  [distributed-validation-risk.mjs#classifyDistributedValidationRisk](./distributed-validation-risk.mjs#classifyDistributedValidationRisk).
  The pure classifier checks both endpoints of copies and renames, selects known distributed-risk
  families, honors only a positive structured plan requirement, and selects fail-closed when
  semantic input is malformed or ambiguous. `workflow_dispatch` is a direct operator override.
- `conclude` calls
  [distributed-validation-result.mjs#validateDistributedValidationResult](./distributed-validation-result.mjs#validateDistributedValidationResult)
  so an intentional no-risk skip is successful while classifier runtime failures and selected
  downstream failures remain visible.

## Control-flow families

- Changed paths enter through
  [read-distributed-validation-input.mjs#readChangedPathRecords](./read-distributed-validation-input.mjs#readChangedPathRecords).
  The classifier owns explicit distributed protocol/controller/headless, realtime
  routing/topology, and deployment-runner path policy. It does not run or duplicate distributed
  recipes.
- The headless policy includes the complete `packages/shared-test/rallar-bb-test/` runtime and
  protocol owner, its shared browser-runtime and JSON-comparison dependencies, the deployed
  `worker:headless` command and script, and the controller/headless application roots. It also
  selects the exact package manifests, npm lockfile, and Deno locks that installation and the
  deployed workspace command use. Adjacent `packages/shared-test` docs and test-data owners remain
  outside this cost boundary;
  the root is not otherwise treated as distributed risk. The deployment policy explicitly includes
  `.github/workflows/deploy-hetzner-controller.yml` in addition to the supported Hetzner runner
  workflows and controller scripts.
- Structured plan selection consumes the canonical optional `distributedValidation` contract
  validated by
  [adaptive-plan-record.mjs#validateAdaptivePlanRecord](../plan-adaptation/adaptive-plan-record.mjs#validateAdaptivePlanRecord).
  No active plan means no explicit requirement; a requirement can only add validation and cannot
  waive path risk.
- `.github/workflows/hetzner-supported-distributed-manifests.yml` runs selection first, conditions
  the unchanged shared preparation and supported-manifest runner matrix on that decision, and
  converges both selected and skipped routes through one always-visible result.

Mirrored semantic tests live under `packages/tests/repo/distributed-validation-risk/` and run with
`npm run test:distributed-validation-risk`.
