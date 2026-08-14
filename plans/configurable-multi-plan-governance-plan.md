# Configurable Multi-Plan Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `rallar-repo:adaptive-plan-execution` for the checkpoint lifecycle and
> `rallar-repo:publishing-plan-progress` for publication. Execute only the
> current adaptive slice and stop before merge.

**Goal:** Replace the shared single-plan registry with a compact, configurable catalog that lets
independent plans progress concurrently without weakening plan ownership or authenticated
governance decisions.

**Architecture:** Each canonical plan owns its active or postponed status. One small catalog owner
reads every plan plus `plans/policy.json`, detects capacity and mutable-ownership conflicts, and
writes only an ignored local overview. Existing lifecycle, structure, review, distributed-risk,
and authenticated-decision consumers use that catalog rather than maintaining projections or
merge-shape assumptions.

**Size constraint:** Relative to merged base `d450f2521f93754a39bca5453ee27c8b63988534`,
non-test governance code may grow by no more than 200 net lines. Replace and consolidate existing
single-plan logic before adding new modules.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "configurable-multi-plan-governance",
  "status": "active",
  "goal": "Support up to an administrator-configured number of independent active adaptive plans while removing the tracked shared registry and preserving strict ownership, recovery, merge, and authenticated-decision boundaries.",
  "acceptanceCriteria": [
    "plans/policy.json exactly configures a positive safe-integer active-plan limit with a default repository value of 8, and zero through that limit of disjoint active plans are valid.",
    "Each plan owns an active or postponed status, postpone frees capacity without requiring fresh facts, and resume refreshes target facts while enforcing capacity and mutable-ownership isolation.",
    "Plan facts, structural findings, navigation evidence, PR review, and distributed requirements are evaluated per active plan; disjoint plans with different bases do not stale one another and unassigned qualifying paths fail visibly.",
    "Over-capacity or overlapping catalogs permit only plan-only recovery that strictly improves the invalid state and never permit product or governance-source changes.",
    "plans/README.md is static navigation, the deterministic live overview is written only to ignored .plan-adaptation/overview.md, and no lifecycle or governance transition rewrites a shared registry.",
    "Normal plan lifecycle and closure remain valid after GitHub merge, squash, or rebase merge, while authenticated governance receipts remain restricted to their existing exact direct-main admission path.",
    "Completing, cancelling, superseding, quarantining, or normally closing one plan preserves all other plans, and the migration postpones the conflicting topology plan before completing both implementation slices.",
    "Focused governance validation, broad unit and CI suites, build, independent review, Branch Release Gate, and the 200-line production-governance budget pass on one unchanged candidate tree."
  ],
  "capabilities": [
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [
        "packages/tests/repo/repository-governance.test.ts"
      ],
      "contractPaths": [
        "plans/policy.json",
        "plans/README.md",
        "docs/superpowers/specs/2026-08-12-adaptive-agent-execution-governance-design.md",
        "docs/superpowers/specs/2026-08-13-authenticated-governance-decisions-design.md"
      ],
      "controlFlowFamilies": [
        "catalog and policy discovery",
        "plan-scoped facts and ownership attribution",
        "active and postponed lifecycle mutation",
        "normal and authenticated close-out"
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
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "per-plan declaration and topology evaluation",
        "capability-owned navigation evidence",
        "multi-plan close-out authentication"
      ]
    },
    {
      "owner": "authenticated governance decisions",
      "root": "scripts/governance-decisions",
      "entry": "scripts/governance-decisions.mjs",
      "testRoot": "packages/tests/repo/governance-decisions",
      "focusedCommand": "npm run test:governance-decisions",
      "navigationMap": "scripts/governance-decisions/README.md",
      "controlFlowFamilies": [
        "target-only plan transitions",
        "exact-head publication and structural verification",
        "direct-main authenticated admission"
      ]
    },
    {
      "owner": "PR human review",
      "root": "scripts/pr-human-review",
      "entry": "scripts/pr-human-review.mjs",
      "testRoot": "packages/tests/repo/pr-human-review",
      "focusedCommand": "npm run test:pr-human-review",
      "navigationMap": "scripts/pr-human-review/README.md",
      "contractPaths": [
        ".github/workflows/pr-human-review-record.yml"
      ],
      "controlFlowFamilies": [
        "active-plan review identity",
        "tree-bound reviewed candidate validation"
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
        "packages/tests/repo/github-actions-runtime-governance.test.ts"
      ],
      "controlFlowFamilies": [
        "active-plan requirement selection",
        "postponed-plan exclusion"
      ]
    },
    {
      "kind": "guidance",
      "owner": "adaptive plan execution guidance",
      "skillRoot": ".agents/skills/adaptive-plan-execution",
      "skillEntry": ".agents/skills/adaptive-plan-execution/SKILL.md",
      "contractTestRoot": "packages/tests/repo/adaptive-agent-execution",
      "focusedCommand": "npm run test:adaptive-plan-execution",
      "evaluationRoot": ".agents/evaluations/adaptive-agent-execution/v1",
      "contractPaths": []
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
    "currentHypothesis": "A generated tracked registry and one shared active-plan assumption make unrelated plans contend on lifecycle state, facts, and merge history.",
    "intendedHypothesis": "Per-plan status plus one read-only catalog lets disjoint plans progress independently while capacity, exclusive mutable ownership, and exact authenticated disposition remain explicit policy boundaries.",
    "invalidatedAssumptions": []
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "8dd96d4517e9f5a33728330f6c3bc9fba77bed6c",
    "affectedCodeDigest": "f4473c94cdb0797732437d1db2d2ebce5fb34edec618d0b693cfd394f8e5995e",
    "computedTriggers": [
      "ownership-change",
      "lifecycle-change"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "The second exact-head Branch Release Gate exposed the CI local-transport fixture inheriting GITHUB_ACTIONS and a nine-line budget overrun; the fixture now declares local transport explicitly and consolidated lifecycle calls leave production governance at 199 net lines.",
    "learning": "Transport tests must override ambient CI identity variables, and release-driven readability corrections must be consolidated within the same fixed production-line budget.",
    "structure": "No public interface or ownership changed; the test isolates its intended transport and the lifecycle keeps named input objects without adding another abstraction.",
    "decision": "amend",
    "nextSlices": []
  },
  "structuralDispositions": [
    {
      "kind": "predecessor-path",
      "path": "scripts/plan-adaptation/active-plan-registry.mjs",
      "disposition": "consolidate",
      "destination": "scripts/plan-adaptation/adaptive-plan-catalog.mjs",
      "owner": "plan adaptation",
      "rationale": "The replacement catalog owns policy, plan discovery, capacity, ownership findings, and ignored overview generation in one direct lifecycle boundary."
    },
    {
      "kind": "ownership-contract",
      "target": "scripts/plan-adaptation",
      "disposition": "consolidate",
      "rationale": "Per-plan status, selection, facts, and catalog recovery belong together in the existing plan-adaptation capability instead of a parallel manager."
    },
    {
      "kind": "ownership-contract",
      "target": "existing governance consumers",
      "disposition": "keep",
      "rationale": "Repository structure, review, distributed-risk, and authenticated-decision owners keep their domain decisions and consume the catalog through one direct contract."
    }
  ],
  "freshStructuralReview": {
    "status": "complete",
    "failures": []
  },
  "coldNavigationEvidence": null,
  "materialDecisions": [
    {
      "date": "2026-08-14",
      "decision": "amend",
      "summary": "Replace shared single-plan state with a compact configurable catalog, cap active plans at eight initially, and preserve direct-main receipt authentication unchanged."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "The catalog and lifecycle slice now supports an exact eight-plan policy, per-plan status, ignored overview generation, plan-scoped facts, ownership isolation, and strict recovery."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "All catalog consumers now operate per active plan, target-only disposition preserves peers, the topology plan is postponed, and ordinary lifecycle evidence is independent of merge, squash, or rebase commit shape."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "The implementation is complete with distinct selection modes for owned facts, unassigned qualifying preparation scope, and all materially changed structure-check scope."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "The implementation and organizing-repository-structure evaluation contract are aligned with the catalog terminal, with no undeclared qualifying paths."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "The complete governance implementation and its subprocess-heavy integration scenarios are ready for the broad acceptance matrix."
    },
    {
      "date": "2026-08-14",
      "decision": "amend",
      "summary": "The exact-head Branch Release Gate exposed two new function input-contract findings; both private lifecycle functions now accept named input objects, and the 93 plan-adaptation tests plus the changed-style comparison pass."
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "Current main at 8dd96d45 merged cleanly; its D6 product work is now baseline, while the catalog remains one active governance plan and one postponed topology plan with seven available slots."
    },
    {
      "date": "2026-08-14",
      "decision": "amend",
      "summary": "The second exact-head Branch Release Gate exposed the CI local-transport fixture inheriting GITHUB_ACTIONS and a nine-line budget overrun; the fixture now declares local transport explicitly and consolidated lifecycle calls leave production governance at 199 net lines."
    }
  ]
}
```

## Slice 1: `multi-plan-catalog-and-lifecycle`

- Replace the active-plan registry with exact policy parsing, catalog discovery, capacity, status,
  ownership, recovery, and deterministic ignored-overview behavior.
- Add `overview`, `postpone`, and `resume`; require explicit target selection when ambiguous and
  reject active-only lifecycle commands against postponed plans.
- Compute plan-scoped facts, report unassigned qualifying paths, and keep prepare-time scope growth
  visible to the selected plan.
- Convert `plans/README.md` to static navigation and remove every tracked-registry write.
- Checkpoint, refresh compatibility, and complete the slice before widening consumers.

## Slice 2: `multi-plan-consumers-and-migration`

- Aggregate repository-structure and navigation evidence per active plan and preserve other plans
  during normal and authenticated disposition.
- Select distributed requirements and code-review identity from active plans only.
- Add strict recovery-only behavior for invalid catalogs and tree-based merge, squash, and rebase
  fixtures without widening authenticated receipt admission.
- Postpone the topology evidence-ledger plan through the new command, refresh plan-scoped facts,
  run the full acceptance matrix, and complete independent review and Branch Release Gate.

