# Governance Gate navigation map

```repository-navigation-v1
{
  "version": 1,
  "entry": {
    "path": "scripts/governance-gate.mjs",
    "symbol": "runGovernanceGateCommand"
  },
  "results": [
    {
      "path": "scripts/governance-gate.mjs",
      "symbol": "printResults"
    }
  ],
  "failures": [
    {
      "path": "scripts/governance-gate/run-governance-gate.mjs",
      "symbol": "toFailureSummary"
    }
  ]
}
```

[scripts/governance-gate.mjs#runGovernanceGateCommand](../governance-gate.mjs#runGovernanceGateCommand)
is the canonical local entry. It validates the repository argument, delegates execution, and emits
only ordered phase results or bounded phase-specific failure output.

## Control-flow families

- [governance-gate-phases.mjs#governanceGatePhases](./governance-gate-phases.mjs#governanceGatePhases)
  owns the four package-command boundaries. The adaptive-plan and repository-structure checks
  consume their canonical current facts. Review Record v2 and adaptive governance run their
  focused deterministic contract suites. Missing or empty commands fail before any phase starts.
- [run-governance-gate.mjs#runGovernanceGate](./run-governance-gate.mjs#runGovernanceGate) runs
  those independent read-only phases concurrently so the local path stays bounded by the slowest
  focused suite instead of their sum. It retains output only for a failing phase and limits that
  diagnostic to its final relevant lines.
- [scripts/governance-gate.mjs#printResults](../governance-gate.mjs#printResults) is the result and
  exit owner. Any non-zero phase makes the gate non-zero; successful sibling output cannot hide the
  failing owner.

`npm run check:governance-gate` is the local command. Mirrored semantic and workflow contract tests
live under `packages/tests/repo/governance-gate/` and run with `npm run test:governance-gate`.
`.github/workflows/governance-gate.yml` installs dependencies and invokes only the local command.
The branch workflow requires that reusable job before its existing broad Release Gate, which
remains the sole owner of broad build and test validation.
