# Authenticated Governance Decisions Tactical Plan

Deliver one auditable administrator-only escape hatch for adaptive-plan and repository-governance
blockers while preserving ordinary pull-request governance and truthful evidence.

## Legacy baseline and exit criteria

Existing normal plan closure and PR-backed exception registries remain canonical compatibility
paths. The new capability adds one receipt-backed path and does not duplicate their normal
validation logic. Completion requires every changed compatibility consumer to delegate receipt
validation to the one governance-decisions owner, with no parallel receipt parser or fabricated
legacy evidence.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "authenticated-governance-decisions",
  "status": "active",
  "goal": "Provide one authenticated, atomic, and auditable administrator-only path for resolving adaptive-plan and governance blockers without a pull request.",
  "acceptanceCriteria": [
    "A current repository administrator can preview or atomically apply each fixed decision through the local gh command or workflow without caller-supplied identity.",
    "Every applied decision is content-bound to an exact expected head and immutable canonical receipt, and stale, malformed, mixed, unauthenticated, or unverifiable operations fail closed.",
    "Plan dispositions preserve truthful acceptance states and never fabricate normal closure or pull-request evidence.",
    "Gate deviations preserve failed evidence, and receipt-backed exceptions expire on fingerprint change or revocation while existing registries remain valid.",
    "Exact decision-only main commits retain governance verification while skipping only runtime deployment and distributed validation; other commits keep existing workflows.",
    "Focused repository-governance validation, broad unit and CI suites, build, independent review, and Branch Release Gate pass on one unchanged candidate tree."
  ],
  "capabilities": [
    {
      "owner": "authenticated governance decisions",
      "root": "scripts/governance-decisions",
      "entry": "scripts/governance-decisions.mjs",
      "testRoot": "packages/tests/repo/governance-decisions",
      "focusedCommand": "npm run test:governance-decisions",
      "navigationMap": "scripts/governance-decisions/README.md",
      "factContracts": [
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/pr-human-review/trusted-retained-legacy.mjs",
        "scripts/repo-structure-check/structure-exceptions.mjs",
        "scripts/repo-style-check/reviewed-dispositions.mjs",
        "scripts/test-structure-coupling-registry-report.mjs"
      ],
      "contractPaths": [
        ".github/workflows/deploy.yml",
        ".github/workflows/hetzner-supported-distributed-manifests.yml",
        "docs/superpowers/specs/2026-08-13-authenticated-governance-decisions-design.md",
        "docs/superpowers/plans/2026-08-13-authenticated-governance-decisions.md"
      ],
      "controlFlowFamilies": [
        "request validation and pure transition",
        "local and workflow authentication and publication",
        "commit and receipt verification",
        "receipt-backed governance resolution"
      ]
    },
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/plan-adaptation/plan-closure-receipt.mjs"
      ],
      "controlFlowFamilies": [
        "lifecycle mutation",
        "read-only validation",
        "normal and governance close-out authentication"
      ]
    },
    {
      "owner": "governance gate",
      "root": "scripts/governance-gate",
      "entry": "scripts/governance-gate.mjs",
      "testRoot": "packages/tests/repo/governance-gate",
      "focusedCommand": "npm run test:governance-gate",
      "navigationMap": "scripts/governance-gate/README.md",
      "factContracts": [
        "packages/tests/repo/github-actions-runtime-governance.test.ts"
      ],
      "contractPaths": [
        ".github/workflows/governance-gate.yml"
      ],
      "controlFlowFamilies": [
        "local phase orchestration",
        "focused contract validation",
        "GitHub early-gate integration"
      ]
    },
    {
      "owner": "repository structure",
      "root": "scripts/repo-structure-check",
      "entry": "scripts/repo-structure-check.mjs",
      "testRoot": "packages/tests/repo/repo-structure-check",
      "focusedCommand": "npm run test:repo-structure",
      "navigationMap": "scripts/repo-structure-check/README.md",
      "factContracts": [
        "scripts/plan-adaptation/active-plan-registry.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "repository inventory",
        "topology and disposition evaluation",
        "exception authentication"
      ]
    },
    {
      "owner": "PR human review",
      "root": "scripts/pr-human-review",
      "entry": "scripts/pr-human-review.mjs",
      "testRoot": "packages/tests/repo/pr-human-review",
      "focusedCommand": "npm run test:pr-human-review",
      "navigationMap": "scripts/pr-human-review/README.md",
      "factContracts": [
        "scripts/check-pr-human-review-legacy-stages.mjs",
        "scripts/pr-human-review/trusted-retained-legacy.mjs"
      ],
      "controlFlowFamilies": [
        "review evidence validation",
        "trusted retained-legacy approval"
      ]
    },
    {
      "owner": "distributed validation risk",
      "root": "scripts/distributed-validation-risk",
      "entry": "scripts/distributed-validation-risk.mjs",
      "testRoot": "packages/tests/repo/distributed-validation-risk",
      "focusedCommand": "npm run test:distributed-validation-risk",
      "navigationMap": "scripts/distributed-validation-risk/README.md",
      "factContracts": [
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "packages/tests/repo/github-actions-runtime-governance.test.ts"
      ],
      "controlFlowFamilies": [
        "changed-path risk classification",
        "workflow selection"
      ]
    },
    {
      "kind": "guidance",
      "guidanceRole": "router",
      "owner": "general agent guidance",
      "routingEntry": "AGENTS.md",
      "contractTestRoot": "packages/tests/repo/general-agent-guidance",
      "focusedCommand": "npm run test:general-agent-guidance",
      "evaluationRoot": null,
      "contractPaths": [
        ".agents/skills/adaptive-plan-execution/SKILL.md",
        ".agents/skills/publishing-plan-progress/SKILL.md"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "Governance exits are distributed across normal PR evidence and heterogeneous exception registries, so stale or impossible prerequisites require another PR or manual intervention.",
    "intendedHypothesis": "One fixed-operation decision capability owns canonical requests, authentication, atomic transitions, immutable receipts, and verification; existing checkers consume its truthful decisions without duplicating authentication.",
    "invalidatedAssumptions": [
      "Administrator validation alone protects a workflow that can access the GitHub App private key.",
      "The new workflow alone can classify and suppress existing main-push deployment and distributed jobs.",
      "Plan disposition, both remote transports, publication verification, workflow classification, and four exception consumers form one independently reviewable slice."
    ],
    "freshInitialReview": {
      "status": "passed",
      "base": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
      "criticalFindings": 0,
      "importantFindings": 5,
      "disposition": "Resolved before implementation: require a main-only protected environment and trusted workflow-source preflight; integrate fail-closed classification into deploy and Hetzner workflows; define fixed per-consumer exception projections; and split core decisions from authenticated publication before activating exceptions."
    },
    "compatibilityReview": {
      "initialBase": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
      "base": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
      "result": "Compatible — no plan delta",
      "checkedSurfaces": "Plan adaptation, governance gate, exception registries, workflow selection, agent guidance, and package scripts."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "8ee348e215a3e30d9b4959ce90369aea1b55b620",
    "affectedCodeDigest": "6c4fa409703a7d49ac0ac4eba91cfa5d1e76febf742497662db412ad495ad663",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "invalid-assumption"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "The deterministic decision core now validates exact requests and receipts, computes all five plan transitions, and structurally verifies decision-only commits with 25 focused tests passing.",
    "learning": "Separating pure transition evidence from GitHub authentication kept the security rules directly testable and confirmed that publication can consume one deterministic addition/deletion contract.",
    "structure": "The governance-decisions owner is directly navigable with one command entry, cohesive policy and snapshot boundaries, mirrored tests, and no undeclared paths; retain the current structure for authenticated publication.",
    "decision": "continue",
    "nextSlices": [
      "authenticated-plan-publication"
    ]
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "scripts/governance-decisions",
      "disposition": "keep",
      "rationale": "The folder names one security and lifecycle boundary whose request, decision, publication, and verification flow benefits from a direct navigation map."
    },
    {
      "kind": "ownership-contract",
      "target": "existing governance consumers",
      "disposition": "keep",
      "rationale": "Existing checkers retain their domain policy and consume one receipt resolver instead of moving unrelated governance rules into the new capability."
    }
  ],
  "freshStructuralReview": {
    "status": "complete",
    "failures": []
  },
  "coldNavigationEvidence": {
    "status": "passed",
    "summary": "A fresh probe resolved the governance command entry, pure transition result, structural verifier, mirrored test root, and navigation map without using the plan as a map.",
    "probes": [
      {
        "capabilityOwner": "authenticated governance decisions",
        "symbol": "computeGovernanceDecisionTransition",
        "path": "scripts/governance-decisions/governance-decision-transition.mjs"
      },
      {
        "capabilityOwner": "authenticated governance decisions",
        "symbol": "verifyGovernanceDecisionCommit",
        "path": "scripts/governance-decisions/governance-decision-commit-verification.mjs"
      }
    ]
  },
  "materialDecisions": [
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The initial review preserved the capability goal but exposed workflow credential and main-push integration gaps before implementation."
    },
    {
      "date": "2026-08-13",
      "decision": "continue",
      "summary": "The deterministic decision core now validates exact requests and receipts, computes all five plan transitions, and structurally verifies decision-only commits with 25 focused tests passing."
    }
  ]
}
```

## Current horizon

1. `governance-decision-core`
2. `authenticated-plan-publication`

## Validation boundary

Run the focused governance suites after each slice. The final unchanged candidate tree requires
the broad unit, CI, build, repository-style, adaptive-governance, and Branch Release Gate evidence
listed in the implementation plan. Product black-box, database, game, performance, and distributed
recipes remain skipped unless the risk classifier finds an unexpected runtime path.
