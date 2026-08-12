# Adaptive Agent Execution Governance Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`,
> `rallar-repo:publishing-plan-progress`, `rallar-repo:rallar-code-writing`, and
> `rallar-repo:rallar-testing`. This plan is intentionally concrete for only
> two slices at a time. Later outcomes are activated and placed at checkpoints.

**Goal:** Implement an automation-first control loop that lets agent work adapt
while converging into human-navigable repository structure.

**Architecture:** One canonical adaptive-plan record and CLI compute change
facts and enforce a two-slice horizon. A separate repository-structure capability
checks objective navigation invariants without choosing folder names. Fresh
initial and final reviews bookend cheap implementing-agent checkpoints.

**Tech stack:** Node.js ESM, Git plumbing, Vitest, Markdown skills, GitHub
Actions, and the existing PR-review/governance scripts.

## Global constraints

- No product runtime APIs change.
- Work from refreshed `origin/main` on `codex/adaptive-agent-execution` in an
  isolated worktree.
- Existing structural debt is baselined; narrow unrelated work is not blocked.
- Automation computes facts and verifies evidence. Agents retain architectural
  judgment and must disposition non-mechanical findings.
- At most two concrete capability slices may be active.
- Local checks stay affected and risk-proportional until the final completion
  gate. Broad GitHub validation is content-sensitive; distributed validation
  is risk-scoped.
- The introducing PR is the sole bootstrap exception for base-branch workflows
  that cannot validate their own replacement.
- Search or create GitHub Issues only for verified material work genuinely
  deferred or requiring a human decision.
- Each active capability has a resolvable owner, canonical entry, mirrored test
  root, and focused command. A durable live navigation map is required only
  when the implemented module/control-flow threshold is crossed; the design
  specification is rationale, not a substitute for that map.
- `test:plan-adaptation` and `test:repo-structure` are the focused commands.
  `test:adaptive-governance` is their aggregate test command and
  `check:adaptive-governance` is the read-only governance entry. The combined
  local path must remain below ten seconds and the GitHub Governance Gate below
  two minutes.

## Bootstrap evidence

- Base commit: `4b2394d618a5b5b27dac83ce7fec025c9c9554d2`.
- Baseline unit result: 766 files passed, 3 skipped, and one unrelated file
  failed; 6,927 tests passed and 5 skipped. The failure is the untouched
  headless bundle budget measuring 198.0449 KiB against `<197` after the base
  commit raised it from `<196`. Classification:
  `obsolete-coupled-test` candidate, not an invalid assumption in this plan.
- No behavior-shaping skill has been authored yet. Fresh-agent baseline
  scenarios and the initial architecture verdict are recorded in the ignored
  execution workspace before Slice 1 begins.

## Legacy baseline and exit criteria

The implementation must close, not duplicate, these affected existing
controls:

| Existing owner and entry/call path                                                                                                                                                                                                                                                                                                                                                                            | Purpose                                                                                                 | Initial disposition | Exit criterion                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/repo-style-check.mjs` → `scripts/repo-style-check/layout-rules.mjs#scanRepositoryLayout` / `layoutRuleIds`; `scripts/check-changed-repo-style.mjs` changed-finding comparison                                                                                                                                                                                                                        | Directory density, feature-prefix clustering, file-size/style facts, and changed-surface enforcement    | `keep`              | Repo style remains the single fact implementation; repository structure consumes an intentionally exported contract and adds no parallel metric implementation.                                                             |
| `package.json#scripts.test:repo-governance` → flat `packages/tests/repo/*.test.ts` arguments                                                                                                                                                                                                                                                                                                                  | Repository contract tests                                                                               | `migrate`           | New capabilities have mirrored test subtrees and exact focused commands; the aggregate governance command includes them without source-text coupling.                                                                       |
| `AGENTS.md` Start Here / Validation; `.agents/skills/publishing-plan-progress/SKILL.md`; `.agents/skills/rallar-code-writing/SKILL.md`; `.agents/skills/rallar-testing/SKILL.md` → `.agents/skills/rallar-testing/references/test-commands.md`                                                                                                                                                                | Startup issue search, exact-SHA, unconditional full-suite, and overlapping plan-execution rules         | `minimize`          | The new behavior skills own adaptation/structure; general guidance routes to them and publication owns publication only.                                                                                                    |
| `.github/PULL_REQUEST_TEMPLATE.md` and `docs/pr-human-review-record.md`; `.github/workflows/pr-human-review-record.yml#jobs.validate` → `scripts/check-pr-human-review.mjs` → `scripts/pr-human-review/validate-record.mjs`, `validate-review-evidence.mjs`, and `trusted-retained-legacy.mjs`; `scripts/check-pr-human-review-legacy-stages.mjs` → `scripts/review-legacy.mjs` and `scripts/legacy-review/*` | PR Human Review Record v1 initial, repeated milestone, final, trusted-review, and legacy-stage evidence | `remove`            | v2 replaces the v1 template, contract, validator entry, workflow label, and stage integration directly; reusable legacy candidate scanning remains only behind the v2 owner, with no permanent v1 validator or dual record. |
| `.github/workflows/branch-release-gate.yml#jobs.release-gate`; `.github/workflows/hetzner-supported-distributed-manifests.yml#jobs.preflight/prepare/run` on `push: main`; `AGENTS.md` completion-gate text                                                                                                                                                                                                   | Broad and distributed completion validation                                                             | `migrate`           | Governance runs first, broad evidence is content-sensitive, and Hetzner is selected only by distributed risk or explicit plan acceptance.                                                                                   |

Every changed or discovered predecessor path receives `remove`, `minimize`,
`migrate`, or `propose-retention` before completion. `propose-retention`
requires the existing explicit human approval contract. A thorough independent
final review freezes the build-affecting tree/plan digest, traces the changed
governance entry-to-result paths, and repeats after any invalidating change.

## Current horizon

### Task 1: Slice 1 — plan-adaptation tooling

**Owned capability:** `scripts/plan-adaptation/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/`

- [ ] Write failing focused tests for record parsing/replacement, canonical
      content digests, qualifying diffs, undeclared paths, triggers, two-slice
      enforcement, consolidation escalation, registry generation, and close-out.
- [ ] Implement one cohesive capability with a thin
      `scripts/plan-adaptation.mjs` command entry.
- [ ] Add `plan:adapt` and focused governance scripts to `package.json`.
- [ ] Add a semantic CLI-boundary test for the real
      `init`/`complete-slice`/`prepare`/`apply`/`check`/`close` flow, not only parser
      tests, and make `test:plan-adaptation` the exact focused command.
- [ ] Keep `test:plan-adaptation` below ten seconds.
- [ ] Review the slice against this plan and record checkpoint facts without
      activating later outcomes.

**Legacy impact:** Add no second plan registry, digest implementation, or
milestone-review narrative. This slice introduces the canonical adaptive-plan
lifecycle and records predecessor review/publication controls for later
minimization or removal.

### Task 2: Slice 2 — repository-structure automation

**Owned capability:** `scripts/repo-structure-check/`

**Canonical entry:** `scripts/repo-structure-check.mjs`

**Mirrored tests:** `packages/tests/repo/repo-structure-check/`

- [ ] Write failing focused tests for singleton subtrees, redundant nesting,
      semantic-depth dispositions, canonical entries, mirrored tests, navigation
      maps, changed-surface debt activation, and unrelated-debt fixtures.
- [ ] Cover authored code under `apps`, `packages`, `scripts`, `examples`, and
      tests with explicit generated/tool exclusions.
- [ ] Block new or materially activated singleton authored-code subtrees and
      redundant one-child chains. Require explicit human-approved production
      exceptions with an owner and review/removal condition.
- [ ] Require declarations for capability entries, mirrored test roots, and
      complex-feature navigation maps. Report density, prefix clustering, size,
      and semantic depth as mandatory dispositions, never automatic splits.
- [ ] Keep repo style as the canonical implementation for its existing
      density, prefix-clustering, and file-size facts. Consume one intentionally
      exported fact contract; do not compute those metrics again.
- [ ] Add a semantic command-boundary test and make `test:repo-structure` the
      exact focused command. Route both focused commands through
      `test:adaptive-governance` and keep the aggregate below ten seconds.
- [ ] Run the checkpoint and a fresh cold-navigation probe before activating
      later work.

**Legacy impact:** Preserve repo-style compatibility while preventing parallel
metric owners. Migrate only the affected new tests into the mirrored subtree;
do not reorganize unrelated flat test debt.

## Checkpoint-activated outcomes

These outcomes are fixed; their exact file placement and concrete slice pairing
are selected at the preceding checkpoint.

1. Behavior skills and RED-GREEN-REFACTOR fresh-agent evaluations.
2. General guidance simplification and routing through the new skill owners.
3. Direct PR Human Review Record v2 cutover and deterministic contract tests.
4. A fast Governance Gate before expensive CI.
5. Content-sensitive `validation-evidence-v1` production and reuse.
6. Risk-scoped Hetzner distributed validation with manual dispatch retained.
7. `Complete Code and Legacy Review`: freeze and record the exact merge-base
   and candidate-head SHAs plus the build-affecting-tree and plan
   goal/acceptance/current-structure digest; use a fresh reviewer to trace every
   changed governance owner from entry to result; disposition all predecessor
   and candidate legacy; verify navigation, tests, compatibility, and
   proportional validation; repeat after invalidating changes; publish final
   evidence; run tactical plan close-out; and retain durable decisions only at
   their real owners.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "adaptive-agent-execution-governance",
  "status": "active",
  "goal": "Implement an automation-first control loop that lets agent work adapt while converging into human-navigable repository structure.",
  "acceptanceCriteria": [
    "Adaptive plans expose no more than two concrete capability slices.",
    "Computed structural and learning triggers require a five-judgment checkpoint.",
    "Changed-surface repository structure is recoverable from entries, tests, and navigation maps.",
    "PR review freshness and broad validation evidence are content-sensitive rather than commit-sensitive.",
    "Distributed validation runs only for classified risk or explicit plan acceptance.",
    "Fresh-agent behavior evaluations pass every critical with-skill scenario.",
    "Each active capability has an exact owner, entry, mirrored test root, and focused command.",
    "The combined local adaptive-governance path remains below ten seconds and its GitHub gate remains below two minutes."
  ],
  "capabilities": [
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [],
      "controlFlowFamilies": [
        "lifecycle mutation",
        "read-only validation",
        "close-out"
      ]
    },
    {
      "owner": "repository structure",
      "root": "scripts/repo-structure-check",
      "entry": "scripts/repo-structure-check.mjs",
      "testRoot": "packages/tests/repo/repo-structure-check",
      "focusedCommand": "npm run test:repo-structure",
      "navigationMap": null,
      "factContracts": [
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "structural scan",
        "declaration validation"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "Plan, style, review, and workflow rules exist as separate controls without one execution-time adaptation owner.",
    "intendedHypothesis": "A plan-adaptation capability owns rolling decisions while a separate repository-structure capability supplies structural facts.",
    "freshInitialReview": {
      "status": "complete",
      "reviewer": "/root/initial_architecture_review",
      "verdict": "pass",
      "evidence": "Fresh-context review passed on 2026-08-12 after two scoped correction rounds resolved exact Slice 2 ownership, legacy inventory and review bounds, canonical structural fact ownership, focused commands, navigation-map evidence, and terminology."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "f07fee5352c94ca215fb00666b93ef80d0daf96d",
    "affectedCodeDigest": "0cb9e2b9c49f1abfa1390d67f29ecc7c32ac88e950041b7511248fd60bdf3513",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "lifecycle-change"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "Slice 2 fix round 2 removes caller-selected exception evidence, verifies registered approvals through authenticated gh API lookup, scopes shell navigation evidence, and excludes generated/tool nodes before filesystem inspection.",
    "learning": "Trusted review input must be derived from the repository and registry rather than a caller path; fail-closed inspection must distinguish authored scope from explicit exclusions before touching filesystem metadata.",
    "structure": "scripts/repo-structure-check keeps one exception-verification boundary with injectable pure lookup tests and production gh API access only for nonempty registries; capability declarations retain a bounded shell scope scanner without a parser dependency.",
    "decision": "continue",
    "nextSlices": []
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "scripts/repo-style-check/layout-rules.mjs density, prefix-clustering, and file-size facts",
      "disposition": "keep",
      "rationale": "Repo style remains canonical; repository structure consumes one exported fact contract and owns only topology and disposition policy."
    }
  ],
  "freshStructuralReview": null,
  "coldNavigationEvidence": null,
  "materialDecisions": [
    {
      "date": "2026-08-12",
      "decision": "Use one lightweight initial review, automated adaptive checkpoints, and one thorough final review."
    },
    {
      "date": "2026-08-12",
      "decision": "Activate only two concrete slices; retain later work as outcomes until checkpoint evidence selects placement."
    },
    {
      "date": "2026-08-12",
      "decision": "Initial review fixed repository structure at scripts/repo-structure-check with mirrored tests and kept existing repo-style metrics canonical."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 1 provides the complete canonical adaptive-plan lifecycle through one thin command entry, including fresh checkpoint drafts, content-sensitive apply/check behavior, a generated format-stable registry, and final-evidence-gated close-out."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 1 fix round 1 closes qualification bypasses, confines repository paths, symlink roots, and Git revisions, binds drafts to their source record, makes multi-file lifecycle changes transactional, strengthens checkpoint/schema rules, and derives digest modes and rename tuples from Git facts."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 1 fix round 2 removes partial-state transaction rollback paths, makes post-commit backup cleanup unambiguous, and confines registry discovery before repository-controlled reads or writes."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 2 adds a read-only repository-structure command that baselines unrelated debt, blocks changed singleton and redundant topology, validates declared navigation evidence, and requires human dispositions for structural facts."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 2 fix round 1 binds exceptions and dispositions to exact current evidence, fails closed on unsafe repository paths, strengthens capability reality, and requires one schema-valid active plan diff base."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "Slice 2 fix round 2 removes caller-selected exception evidence, verifies registered approvals through authenticated gh API lookup, scopes shell navigation evidence, and excludes generated/tool nodes before filesystem inspection."
    }
  ]
}
```
