# Evolving Standards and Maintenance Stewardship Plan

**Goal:** Make maintenance of existing code an ordinary execution responsibility: an agent becomes
the temporary steward of every human-authored code file it changes, resolves real current-standard
violations throughout that file, recursively closes every support file it modifies, and leaves
independent untouched code outside the task.

**Architecture:** The authoritative code standard defines touched-file standards closure. The
code-writing and adaptive-plan skills translate it into an explicit execution and escalation loop.
Versioned external evaluations test the behavior with non-compensable gates, while PR Human Review
Record v2 binds closure evidence to the reviewed candidate tree.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "evolving-standards-maintenance-stewardship",
  "status": "active",
  "goal": "Make touched-file maintenance stewardship ordinary agent execution while preserving requested behavior, safety, compatibility, recursive closure, and independent untouched-code containment.",
  "acceptanceCriteria": [
    "The authoritative standard states that pre-existing noncompliance is neither precedent nor a no-touch boundary and requires complete standards closure for every changed human-authored code file.",
    "Every support file modified by remediation enters closure recursively, while independent untouched code remains outside the task.",
    "Deadline, diff-size, package-boundary, cleanup-volume, and checker-tolerance pressure do not justify retaining real touched-file violations or seeking permission solely because debt is old.",
    "Escalation remains limited to a genuine remaining exception, a public compatibility or migration decision, an unresolved correctness or safety conflict, or a failed navigation probe after one autonomous coherent consolidation.",
    "PR Human Review Record v2 requires finalReview.touchedFileStandardsClosure and rejects missing, blank, placeholder, stale, or visible-to-metadata-mismatched evidence.",
    "Five preserved failing pre-change trials and at least five fresh post-change trials are scored externally through six non-compensable gates, with the final cohort passing every gate and no motivational point system introduced.",
    "Focused guidance, adaptive-plan, PR-review, repository-governance, repository-structure, formatting, changed-style, and Branch Release Gate validation pass on the final candidate tree.",
    "Every changed human-authored file is reviewed and remediated in full, remediation-modified support files recursively enter closure, and independent untouched code remains outside closure."
  ],
  "capabilities": [
    {
      "kind": "guidance",
      "owner": "rallar code writing guidance",
      "skillRoot": ".agents/skills/rallar-code-writing",
      "skillEntry": ".agents/skills/rallar-code-writing/SKILL.md",
      "contractTestRoot": "packages/tests/repo/rallar-code-writing",
      "focusedCommand": "npm run test:rallar-code-writing:capability",
      "evaluationRoot": ".agents/evaluations/rallar-code-writing/v1",
      "contractPaths": [
        "docs/repo-human-style-guide.md",
        "package.json",
        "packages/tests/repo/repo-code-style-authority-integrity.test.ts",
        "packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts"
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
      "contractPaths": []
    },
    {
      "kind": "guidance",
      "owner": "organizing repository structure guidance",
      "skillRoot": ".agents/skills/organizing-repository-structure",
      "skillEntry": ".agents/skills/organizing-repository-structure/SKILL.md",
      "contractTestRoot": "packages/tests/repo/organizing-repository-structure",
      "focusedCommand": "npm run test:organizing-repository-structure",
      "evaluationRoot": ".agents/evaluations/organizing-repository-structure/v1",
      "contractPaths": []
    },
    {
      "owner": "PR human review",
      "root": "scripts/pr-human-review",
      "entry": "scripts/pr-human-review.mjs",
      "testRoot": "packages/tests/repo/pr-human-review",
      "focusedCommand": "npm run test:pr-human-review",
      "navigationMap": "scripts/pr-human-review/README.md",
      "factContracts": [],
      "contractPaths": [
        ".github/PULL_REQUEST_TEMPLATE.md",
        "docs/pr-human-review-record.md"
      ],
      "controlFlowFamilies": [
        "review metadata validation",
        "visible evidence binding",
        "review freshness"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "Accepted-debt and narrow-diff guidance causes agents to treat old noncompliance as a no-touch boundary or a reason to seek permission.",
    "intendedHypothesis": "A bounded touched-file closure rule, explicit escalation conditions, externally scored trials, and tree-bound PR evidence produce ordinary maintenance stewardship without repository-wide cleanup.",
    "freshInitialReview": {
      "status": "complete",
      "reviewer": "initial_plan_review",
      "verdict": "PASS: Critical 0, Important 0, Minor 0; shared-validator ownership, reopening conditions, draft-first publication, and inherited group-formation plan normalization verified on the exact worktree."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "origin/main",
    "affectedCodeDigest": "7a8ac3f0bee399cd5cea1a9b29a69f38629d084fd187ef9563ec0ce75b7a6473",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "The shared evaluation protocol ownership is explicit, every keep judgment has a reopening condition, the inherited governance blocker is normalized, and fresh review passes with no findings.",
    "learning": "Draft-first publication preserves one review surface while allowing exact remote checks and final evidence to mature before plan closure and ready-for-review transition.",
    "structure": "Canonical guidance, evaluation, and PR-review owners remain unchanged; the adaptive evaluator is the thin shared protocol owner and specialist suites remain schema and artifact consumers.",
    "decision": "continue",
    "nextSlices": [
      "publish-validated-maintenance-stewardship"
    ]
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "maintenance stewardship guidance and evaluation",
      "disposition": "keep",
      "rationale": "The authoritative code-writing skill owns the stewardship rule and specialist rubric. Reopen this boundary if stewardship behavior requires a lifecycle or policy that is not specific to code writing."
    },
    {
      "kind": "ownership-contract",
      "target": ".agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs",
      "disposition": "keep",
      "rationale": "The adaptive evaluation root remains the canonical owner of the thin shared result-validation protocol; organizing-structure and code-writing suites supply their own schemas and artifacts without duplicating validation lifecycle. Reopen this boundary if suite-specific validation lifecycle diverges or the cross-owner imports cease to be a thin shared protocol boundary."
    },
    {
      "kind": "ownership-contract",
      "target": "PR Human Review Record v2 closure evidence",
      "disposition": "keep",
      "rationale": "The existing PR-review validator remains the direct owner of required metadata, visible-field agreement, and content-sensitive freshness. Reopen this boundary if closure evidence gains a lifecycle outside pull-request review."
    },
    {
      "kind": "ownership-contract",
      "target": "repository guidance routing",
      "disposition": "keep",
      "rationale": "AGENTS.md stays a concise router to the authoritative standard and skills instead of duplicating their detailed execution rules. Reopen this boundary if routing requires independent executable policy rather than links to canonical owners."
    }
  ],
  "freshStructuralReview": null,
  "coldNavigationEvidence": null,
  "materialDecisions": [
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "Register the previously authorized stewardship work after multi-plan governance closed its overlapping implementation plan, preserving the existing owner boundaries and final behavioral evidence."
    },
    {
      "date": "2026-08-14",
      "decision": "consolidate",
      "summary": "The stewardship implementation remains preserved on the current default-branch base, and the inherited active group-formation plan metadata is parseable and structurally current so deterministic governance can run.",
      "checkpointDigest": "40ec0fed0ce7ada8cb8b6a7bb15e5cf7262266e6f513f0d32736bf8a4d5a9ae6"
    },
    {
      "date": "2026-08-14",
      "decision": "continue",
      "summary": "The shared evaluation protocol ownership is explicit, every keep judgment has a reopening condition, the inherited governance blocker is normalized, and fresh review passes with no findings."
    }
  ]
}
```

## Completed slice: `consolidate-shared-evaluation-ownership`

- Keep the shared result validator under one explicit adaptive-evaluation protocol owner and record
  why the organizing-structure and code-writing suites remain consumers rather than duplicate
  owners.
- Give every structural `keep` judgment a concrete reopening condition.
- Refresh plan facts, structure declarations, and navigation evidence, then checkpoint before
  publication.

## Active slice: `publish-validated-maintenance-stewardship`

- Publish the validated feature branch and create one draft PR with complete Human Review Record v2
  metadata and exact validation evidence.
- Obtain current Branch Release Gate evidence, bind final PR evidence to the unchanged candidate
  tree, and complete the final fresh review.

## Later outcome

- Use the official close command to remove only this tactical plan and create its canonical closure
  receipt, publish that exact-head result, refresh required CI, and mark the PR ready to merge.

## Validation

- Direct behavioral proof: five protocol-valid fresh-context trials pass all six non-compensable
  stewardship gates, with all result JSON validated by the shared evaluator.
- Affected-package proof: focused code-writing, adaptive-plan, general-guidance, organizing-structure,
  and PR-review tests plus repository governance, structure, changed-style, formatting, and Branch
  Release Gate checks.
- No distributed validation is required because the change alters repository guidance, evaluation,
  and review governance without changing a distributed runtime path.
