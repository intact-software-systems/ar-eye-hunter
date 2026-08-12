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

| Existing owner and entry/call path                                                                                                                                                                                                                                                                                                                                                                      | Purpose                                                                                                 | Initial disposition | Exit criterion                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/repo-style-check.mjs` → `scripts/repo-style-check/layout-rules.mjs#scanRepositoryLayout` / `layoutRuleIds`; `scripts/check-changed-repo-style.mjs` changed-finding comparison                                                                                                                                                                                                                  | Directory density, feature-prefix clustering, file-size/style facts, and changed-surface enforcement    | `keep`              | Repo style remains the single fact implementation; repository structure consumes an intentionally exported contract and adds no parallel metric implementation.                                                             |
| `package.json#scripts.test:repo-governance` → flat `packages/tests/repo/*.test.ts` arguments                                                                                                                                                                                                                                                                                                            | Repository contract tests                                                                               | `migrate`           | New capabilities have mirrored test subtrees and exact focused commands; the aggregate governance command includes them without source-text coupling.                                                                       |
| `AGENTS.md` Start Here / Validation; `.agents/skills/publishing-plan-progress/SKILL.md`; `.agents/skills/rallar-code-writing/SKILL.md`; `.agents/skills/rallar-testing/SKILL.md` → `.agents/skills/rallar-testing/references/test-commands.md`                                                                                                                                                          | Startup issue search, exact-SHA, unconditional full-suite, and overlapping plan-execution rules         | `minimize`          | The new behavior skills own adaptation/structure; general guidance routes to them and publication owns publication only.                                                                                                    |
| `.github/PULL_REQUEST_TEMPLATE.md` and `docs/pr-human-review-record.md`; `.github/workflows/pr-human-review-record.yml#jobs.validate` → `scripts/pr-human-review.mjs` → `scripts/pr-human-review/validate-record.mjs`, `validate-review-evidence.mjs`, and `trusted-retained-legacy.mjs`; `scripts/check-pr-human-review-legacy-stages.mjs` → `scripts/review-legacy.mjs` and `scripts/legacy-review/*` | PR Human Review Record v1 initial, repeated milestone, final, trusted-review, and legacy-stage evidence | `remove`            | v2 replaces the v1 template, contract, validator entry, workflow label, and stage integration directly; reusable legacy candidate scanning remains only behind the v2 owner, with no permanent v1 validator or dual record. |
| `.github/workflows/branch-release-gate.yml#jobs.release-gate`; `.github/workflows/hetzner-supported-distributed-manifests.yml#jobs.preflight/prepare/run` on `push: main`; `AGENTS.md` completion-gate text                                                                                                                                                                                             | Broad and distributed completion validation                                                             | `migrate`           | Governance runs first, broad evidence is content-sensitive, and Hetzner is selected only by distributed risk or explicit plan acceptance.                                                                                   |

Every changed or discovered predecessor path receives `remove`, `minimize`,
`migrate`, or `propose-retention` before completion. `propose-retention`
requires the existing explicit human approval contract. A thorough independent
final review freezes the build-affecting tree/plan digest, traces the changed
governance entry-to-result paths, and repeats after any invalidating change.

## Completed foundation

### Task 1: Slice 1 — plan-adaptation tooling

**Owned capability:** `scripts/plan-adaptation/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/`

- [x] Write failing focused tests for record parsing/replacement, canonical
      content digests, qualifying diffs, undeclared paths, triggers, two-slice
      enforcement, consolidation escalation, registry generation, and close-out.
- [x] Implement one cohesive capability with a thin
      `scripts/plan-adaptation.mjs` command entry.
- [x] Add `plan:adapt` and focused governance scripts to `package.json`.
- [x] Add a semantic CLI-boundary test for the real
      `init`/`complete-slice`/`prepare`/`apply`/`check`/`close` flow, not only parser
      tests, and make `test:plan-adaptation` the exact focused command.
- [x] Keep `test:plan-adaptation` below ten seconds.
- [x] Review the slice against this plan and record checkpoint facts without
      activating later outcomes.

**Legacy impact:** Add no second plan registry, digest implementation, or
milestone-review narrative. This slice introduces the canonical adaptive-plan
lifecycle and records predecessor review/publication controls for later
minimization or removal.

### Task 2: Slice 2 — repository-structure automation

**Owned capability:** `scripts/repo-structure-check/`

**Canonical entry:** `scripts/repo-structure-check.mjs`

**Mirrored tests:** `packages/tests/repo/repo-structure-check/`

- [x] Write failing focused tests for singleton subtrees, redundant nesting,
      semantic-depth dispositions, canonical entries, mirrored tests, navigation
      maps, changed-surface debt activation, and unrelated-debt fixtures.
- [x] Cover authored code under `apps`, `packages`, `scripts`, `examples`, and
      tests with explicit generated/tool exclusions.
- [x] Block new or materially activated singleton authored-code subtrees and
      redundant one-child chains. Require explicit human-approved production
      exceptions with an owner and review/removal condition.
- [x] Require declarations for capability entries, mirrored test roots, and
      complex-feature navigation maps. Report density, prefix clustering, size,
      and semantic depth as mandatory dispositions, never automatic splits.
- [x] Keep repo style as the canonical implementation for its existing
      density, prefix-clustering, and file-size facts. Consume one intentionally
      exported fact contract; do not compute those metrics again.
- [x] Add a semantic command-boundary test and make `test:repo-structure` the
      exact focused command. Route both focused commands through
      `test:adaptive-governance` and keep the aggregate below ten seconds.
- [x] Run the checkpoint and a fresh cold-navigation probe before activating
      later work.

**Legacy impact:** Preserve repo-style compatibility while preventing parallel
metric owners. Migrate only the affected new tests into the mirrored subtree;
do not reorganize unrelated flat test debt.

## Completed consolidation

### Task 3: Foundational governance navigation and active-plan truth consolidation

**Decision:** This one autonomous consolidation slice replaces the next feature
slice. No checkpoint-activated outcome is active until the post-consolidation
cold probe passes.

- [x] Declare repository structure's real control-flow and trust families
      without collapsing them into generic scan vocabulary.
- [x] Add the required owner-local repository-structure navigation map. It must
      link the canonical entry and the inventory/classification,
      topology/disposition, capability navigation, authenticated exception,
      active-plan configuration, and repo-style fact-contract boundaries.
- [x] Correct the plan-adaptation navigation map so mutation, read-only check,
      and destructive close commands link to their actual lifecycle owners and
      exits.
- [x] Keep completed Slices 1 and 2 under `Completed foundation`; the generated
      active index and checkpoint identify this consolidation as the sole
      current slice.
- [x] Run focused/read-only adaptive governance and repeat the exact fresh cold
      probes. A failed post-consolidation probe requires `stop` and human
      direction; a pass may activate only the next two outcome slices.

**Legacy impact:** Replace inaccurate navigation prose and stale active-plan
status directly. Do not add a second map, a compatibility alias, a parallel
owner, or an implementation-plan dependency for normal code navigation.

## Completed behavior horizon

The first skill's GREEN candidate exposed a scope-growth trigger: the active
record can declare authored-code capabilities but cannot truthfully declare a
skill/evaluation owner. Do not disguise guidance files as code or fact
contracts. This amended horizon adds that missing declaration kind, then
resumes the already-tested skill slice. The repository-structure skill and
guidance simplification return to outcome-shape until the next checkpoint.

### Task 4: Guidance capability declarations

**Owners:** `scripts/plan-adaptation/` and
`scripts/repo-structure-check/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/` and
`packages/tests/repo/repo-structure-check/`

- [x] Extend the adaptive record with a discriminated guidance capability that
      declares one skill root/entry, mirrored contract-test root and focused
      command, optional evaluation root, and explicit cross-owner contract
      paths. Existing code capabilities remain compatible.
- [x] Include the guidance, evaluation, and contract surfaces in undeclared-path
      and affected-scope facts; do not route them through code fact contracts.
- [x] Make repository-structure validation prove the declared skill/evaluation
      files and focused test command without applying authored-code topology,
      semantic-depth, or source-symbol rules to Markdown/JSON guidance.
- [x] Add RED/GREEN coverage at the record, fact, declaration, and live command
      boundaries, then refresh the active record to declare Task 5 honestly.

**Legacy impact:** Add no parallel registry or skill inventory. Preserve the
existing code-capability shape and keep plugin discovery in its current
contract test.

### Task 5: Adaptive plan execution skill and evaluations

**Skill owner:** `.agents/skills/adaptive-plan-execution/SKILL.md`

**Versioned evaluation owner:**
`.agents/evaluations/adaptive-agent-execution/v1/`

- [x] Convert the already-captured no-skill baseline into versioned pressure
      scenarios and a machine-readable result/rubric contract without copying
      ignored model output into the skill.
- [x] Author one concise `adaptive-plan-execution` skill from those observed
      failures. It owns qualification, the two-slice horizon, trigger-based
      reflection, five judgments, consolidation/stop behavior, and
      proportionate validation selection; deterministic commands remain owned
      by `scripts/plan-adaptation/`.
- [x] Add focused deterministic contract tests under
      `packages/tests/repo/adaptive-agent-execution/` for skill discovery,
      record/command routing, scenario coverage, rubric shape, and the boundary
      between agent judgment and automated facts.
- [x] Run the adaptive-plan pressure scenarios with a fresh agent and refine
      only observed loopholes until every critical result complies.
- [x] Validate the skill package and focused contract before starting the next
      skill.

**Legacy impact:** Do not duplicate plan publication, testing catalogs, or
repository-structure judgment. The new skill may point to those owners but may
not restate them.

## Completed planned-capability declaration lifecycle

The completed behavior horizon exposed one lifecycle gap before a future
guidance owner can be declared: a capability declaration required its files to
exist, so it could not reserve the intended owner and affected surface before
implementation began. Task 6 completed that lifecycle transition. The canonical
record now lists the completed slice and has an empty horizon; selecting any
future capability, including a repository-structure skill, requires a later
checkpoint judgment.

### Task 6: Planned capability declaration lifecycle

**Owners:** `scripts/plan-adaptation/` and
`scripts/repo-structure-check/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/` and
`packages/tests/repo/repo-structure-check/`

- [x] Add an optional capability activation state with backward-compatible
      active behavior. A planned declaration binds to exactly one current
      horizon slice and reserves its declared owner, roots, tests, evaluations,
      contracts, and affected-code surface before those files exist.
- [x] Validate the complete declaration shape and safe repository-relative
      paths while planned, but defer file, command, symbol, topology, and
      navigation-map existence checks until activation.
- [x] Reject slice completion while a capability bound to that slice remains
      planned, reject stale planned declarations outside the current horizon,
      and reject plan close-out while any capability remains planned.
- [x] Cover active backward compatibility, planned code and guidance owners,
      affected-surface reservation, activation, completion, stale-horizon, and
      close-out behavior at deterministic and semantic command boundaries.
- [x] Run focused/read-only adaptive governance and complete this slice. A
      later checkpoint must declare the repository-structure skill before
      authoring it.

**Legacy impact:** Extend the one canonical capability registry. Add no staging
registry, placeholder files, permissive missing-file exception, or parallel
scope allowlist.

## Checkpointed behavior attempt

The canonical lifecycle reserved and activated the repository-structure
guidance owner without placeholder files or temporary undeclared scope. The
skill and its deterministic evaluation contracts were implemented, but the
behavior outcome is not complete: independent review rejected summarized
evidence, and the replacement provenance-bound campaign stopped when its first
assisted run recovered only two of six exact navigation facts. General guidance
simplification therefore remains inactive.

### Task 7: Organizing repository structure skill and evaluations

**Planned skill owner:**
`.agents/skills/organizing-repository-structure/SKILL.md`

**Planned versioned evaluation owner:**
`.agents/evaluations/organizing-repository-structure/v1/`

- [x] Turn the existing no-skill flat-versus-singleton, near-limit module, and
      plan-dependent navigation baselines into versioned pressure scenarios and
      a machine-readable rubric/result contract.
- [x] Author one concise skill that owns structural judgment: recover the
      capability owner and owner-to-result path, consume deterministic
      repository-structure facts, choose `keep`, `split`, `move`, or
      `consolidate`, and verify the result with a cold-navigation probe. It must
      not prescribe a folder taxonomy or convert metrics into automatic splits.
- [x] Add focused deterministic contract tests under
      `packages/tests/repo/organizing-repository-structure/` for skill
      discovery, checker/disposition/cold-probe routing, scenario/rubric
      coverage, and the boundary between structural facts and agent judgment.
- [x] Reuse the canonical evaluation-result validator API; add no second result
      validator. Extend its CLI only when needed to select the structure suite
      explicitly while preserving the existing adaptive-suite command.
- [x] Prove the structure pressure scenarios with provenance-bound verbatim
      fresh-agent evidence and pass independent review. The prose-only approach
      failed this criterion; resume it only after the current automation slice
      supplies canonical navigation facts.

**Legacy impact:** Do not duplicate repository metrics, plan adaptation,
publication, or testing catalogs. The skill points agents to the canonical
checker and style facts, while human structural judgment remains visible in the
adaptive record.

## Completed checkpointed behavior

### Task 8: Automated repository navigation evidence

- [x] Extend the canonical repository-structure capability to emit one
      machine-readable navigation-evidence record for a declared capability:
      owner, canonical entry, applicable terminal result and failure symbols,
      mirrored tests, declared focused command, and navigation-map state.
- [x] Derive and validate those facts from the capability declaration,
      repository files, navigation map, package scripts, and source symbols;
      do not ask automation to choose a structural disposition or folder.
- [x] Make the structure skill consume the generated evidence and retain only
      the creative judgments: `keep`, `split`, `move`, or `consolidate`, the
      rationale, reopening conditions, and adaptive-plan reflection.
- [x] Add deterministic and semantic command tests. The frozen provenance
      campaign and independent review remain the unchecked Task 7 acceptance
      criterion and must pass before selecting general guidance simplification.

**Legacy impact:** Replace prompt-enforced fact transcription with one
repository-owned fact artifact. Keep the existing checker, declaration registry,
style facts, skill, and evaluation validator canonical; add no parallel
navigation registry or automatic folder selector.

## Completed two-slice horizon

### Task 9: General agent guidance simplification

**Guidance owner:** general agent guidance

**Planned mirrored contract tests:**
`packages/tests/repo/general-agent-guidance/`

- [x] Make `adaptive-plan-execution` the one execution-time adaptation owner
      and `organizing-repository-structure` the one structural-judgment owner.
      General guidance routes to them without restating their rules.
- [x] Reduce `publishing-plan-progress` to publication, remote evidence,
      compatibility checks, issue handoff, and completion publication. Remove
      its duplicate slice/checkpoint and unconditional local full-suite policy.
- [x] Remove duplicate issue-startup, exact-SHA freshness, unconditional local
      full-suite, plan-adaptation, and structure rules from `AGENTS.md`,
      `rallar-code-writing`, and `rallar-testing`; retain only owner routing and
      each file's actual domain rules.
- [x] Add focused contract tests that reject duplicate rule ownership while
      preserving final completion gates and explicit high-risk validation.

**Legacy impact:** Directly minimize duplicate guidance. Add no compatibility
copy, second plan workflow, second testing catalog, or permanent transition text.

### Task 10: Repository contract-path declarations

**Owners:** `scripts/plan-adaptation/` and
`scripts/repo-structure-check/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/` and
`packages/tests/repo/repo-structure-check/`

- [x] Add exact repository contract paths to code-capability declarations so a
      capability can own non-code contracts such as templates, durable
      Markdown, and workflow definitions without disguising them as authored
      source fact contracts.
- [x] Include those paths in affected-code digests, undeclared-path detection,
      planned-surface reservation, safe repository inventory validation, and
      changed-surface ownership checks. Do not apply source-symbol or topology
      rules to them.
- [x] Reject missing, unsafe, duplicate, or cross-owner contract paths and
      preserve existing code/guidance declaration compatibility.
- [x] Add record, fact, declaration, and semantic command tests, then use the
      new field to declare the later PR Human Review v2 owner honestly.

**Legacy impact:** Extend the existing capability registry and checker. Add no
parallel allowlist, workflow registry, or permissive undeclared-path exception.

## Completed corrective horizon

### Task 11: General guidance routing declaration correction

**Owners:** `scripts/plan-adaptation/` and
`scripts/repo-structure-check/`

**Mirrored tests:** `packages/tests/repo/plan-adaptation/` and
`packages/tests/repo/repo-structure-check/`

- [x] Add a first-class guidance-router declaration whose canonical entry is
      `AGENTS.md`, whose mirrored contract tests are
      `packages/tests/repo/general-agent-guidance/`, and whose declared
      contracts remain the actual specialist skill owners.
- [x] Preserve the existing skill-owned guidance declaration shape without
      letting a router masquerade as a skill root or making publication own
      plan, structure, testing, and code-writing rules.
- [x] Include router entry, tests, evaluations, and contracts in planned and
      active affected-surface facts, while keeping authored-code topology and
      source-symbol rules inapplicable.
- [x] Prove schema, activation, facts, repository inventory, focused command,
      and cold-navigation behavior at deterministic and semantic command
      boundaries, then activate the corrected Task 9 owner.

**Legacy impact:** Correct the one canonical capability registry. Do not rename
the human-navigable `general-agent-guidance` tests to match the publication
skill, create a placeholder routing skill, or keep the invalid ownership model.

## Completed PR-review cutover

### Task 12: PR Human Review Record v2 direct cutover

**Planned owner:** `scripts/pr-human-review/`

**Canonical entry:** `scripts/pr-human-review.mjs`

**Planned mirrored tests:** `packages/tests/repo/pr-human-review/`

- [x] Replace the visible template, durable contract, metadata parser, evidence
      validator, legacy-stage integration, and workflow label with Review Record
      v2 in one cutover. Retain no v1 parser or permanent transition validator.
- [x] Make the initial review cover goal, acceptance criteria, capability-tree
      hypothesis, canonical owner/entry, and the first two slices. Replace
      repeated milestone narratives with one checkpoint record bound to the
      current adaptive-plan digest.
- [x] Bind final freshness to the build-affecting tree digest plus plan goal,
      acceptance criteria, and current structural decision. Unrelated
      documentation changes must not invalidate a valid final review.
- [x] Require the final fresh reviewer to verify declared outcomes, every
      owner-to-result path, navigation, tests, compatibility, proportional
      validation, and complete legacy closure. Preserve trusted retained-legacy
      approval and exact candidate-ledger validation.
- [x] Move focused v2 tests into the mirrored owner, update legacy integration
      tests directly, and prove v1 rejection plus existing-open-PR migration on
      the next synchronization. The introducing PR records the bootstrap
      exception because its base workflow cannot run candidate v2 code.

**Legacy impact:** Delete v1 behavior and labels directly. Preserve only the
trusted retained-legacy and candidate-report behaviors that remain part of v2.

## Completed fast-governance horizon

### Task 13: Fast Governance Gate

**Planned owner:** `scripts/governance-gate/`

**Planned canonical entry:** `scripts/governance-gate.mjs`

**Planned mirrored tests:** `packages/tests/repo/governance-gate/`

- [x] Add one fast local command and GitHub workflow that run adaptive-plan,
      repository-structure, Review Record v2, and their focused deterministic
      contract checks before the expensive Branch Release Gate.
- [x] Make the branch workflow depend on the Governance Gate without copying
      check logic into YAML or weakening the existing broad release workflow.
- [x] Fail closed on missing package commands, stale plan facts, structure
      findings, v1 review contracts, and focused test failure. Emit concise
      phase-specific failures suitable for CI triage.
- [x] Keep the local governance path below ten seconds and target less than two
      minutes in GitHub. Document exact command ownership and add deterministic
      workflow/command contract tests.

**Legacy impact:** Add one early gate and one command owner. Do not create a
second adaptive checker, structure analyzer, PR validator, or broad CI suite.

## Current two-slice horizon

### Task 14: Content-sensitive validation evidence

**Planned owner:** `scripts/validation-evidence/`

**Planned canonical entry:** `scripts/validation-evidence.mjs`

**Planned mirrored tests:** `packages/tests/repo/validation-evidence/`

- [ ] Add one canonical build-affecting tree digest and
      `validation-evidence-v1` reader/writer/validator. Reuse the existing PR
      freshness path classifier as an explicit fact contract rather than
      creating a second definition of build-affecting content.
- [ ] Produce trusted workflow evidence containing repository, workflow and run
      identity, validated head, build-tree digest, successful conclusion, and
      completion time. Fail closed on malformed, expired, untrusted, or
      mismatched evidence.
- [ ] Let Branch Release Gate reuse a prior successful broad run only when its
      head is an ancestor of the candidate, its artifact is still within the
      accepted lifetime, and the current build-tree digest matches. Otherwise
      run the unchanged broad Release Gate and publish fresh evidence.
- [ ] Prove documentation-only reuse and invalidation for code, tests,
      workflows/actions, package metadata, lockfiles, root build configuration,
      agent/plugin contracts, and adaptive-plan contracts.

**Legacy impact:** Replace commit-SHA freshness with content-sensitive evidence
selection. Preserve the broad Release Gate unchanged as the canonical validator
when reuse is not earned.

### Task 15: Risk-scoped distributed validation

**Planned owner:** `scripts/distributed-validation-risk/`

**Planned canonical entry:** `scripts/distributed-validation-risk.mjs`

**Planned mirrored tests:** `packages/tests/repo/distributed-validation-risk/`

- [ ] Add a fast deterministic changed-path classifier for distributed
      protocol/controller/headless, realtime routing/topology, deployment
      runner, and explicit structured plan-acceptance requirements.
- [ ] Run the classifier first on main pushes and condition the existing
      supported-manifest preflight, preparation, and expensive Hetzner matrix on
      its decision. Emit a stable human-readable and machine-readable reason.
- [ ] Preserve manual dispatch as an explicit operator override while keeping
      ordinary unrelated main pushes cheap. Do not weaken or duplicate the
      existing manifest runner or supported-manifest matrix.
- [ ] Prove every selected and non-selected path family, rename endpoints,
      malformed/ambiguous inputs, explicit plan selection, workflow wiring, and
      manual override.

**Legacy impact:** Replace unconditional main-push Hetzner execution with one
risk decision in front of the unchanged distributed runner. Retain manual
dispatch and all existing supported manifests.

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
      "contractPaths": [
        "docs/superpowers/specs/2026-08-12-adaptive-agent-execution-governance-design.md"
      ],
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
      "navigationMap": "scripts/repo-structure-check/README.md",
      "factContracts": [
        "scripts/plan-adaptation/active-plan-registry.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "authored inventory and material-change classification",
        "topology and structural-disposition evaluation",
        "capability and cold-navigation validation",
        "authenticated singleton-exception verification"
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
      "contractPaths": [
        "packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts"
      ]
    },
    {
      "kind": "guidance",
      "owner": "repository structure guidance",
      "skillRoot": ".agents/skills/organizing-repository-structure",
      "skillEntry": ".agents/skills/organizing-repository-structure/SKILL.md",
      "contractTestRoot": "packages/tests/repo/organizing-repository-structure",
      "focusedCommand": "npm run test:organizing-repository-structure",
      "evaluationRoot": ".agents/evaluations/organizing-repository-structure/v1",
      "contractPaths": [
        ".agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs",
        "packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts"
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
        ".agents/skills/organizing-repository-structure/SKILL.md",
        ".agents/skills/publishing-plan-progress/SKILL.md",
        ".agents/skills/rallar-code-writing/SKILL.md",
        ".agents/skills/rallar-testing/SKILL.md",
        ".agents/skills/rallar-testing/references/test-commands.md",
        "packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts",
        "packages/tests/repo/repo-code-style-authority-integrity.test.ts",
        "packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts"
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
        "scripts/legacy-review/candidate-report.mjs",
        "scripts/legacy-review/validate-supplied-evidence.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/review-legacy.mjs",
        "packages/tests/repo/legacy-review.test.ts"
      ],
      "contractPaths": [
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/workflows/pr-human-review-record.yml",
        "docs/README.md",
        "docs/pr-human-review-record.md",
        "docs/production-legacy-exceptions.md",
        "docs/repo-human-style-guide.md"
      ],
      "controlFlowFamilies": [
        "review input and evidence decoding",
        "initial checkpoint and final freshness validation",
        "trusted retained-legacy approval",
        "legacy candidate-stage integration"
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
      "owner": "validation evidence",
      "root": "scripts/validation-evidence",
      "entry": "scripts/validation-evidence.mjs",
      "testRoot": "packages/tests/repo/validation-evidence",
      "focusedCommand": "npm run test:validation-evidence",
      "navigationMap": "scripts/validation-evidence/README.md",
      "factContracts": [
        "scripts/pr-human-review/review-freshness.mjs"
      ],
      "contractPaths": [
        ".github/workflows/branch-release-gate.yml",
        ".github/workflows/release-gate.yml"
      ],
      "controlFlowFamilies": [
        "build-tree digest computation",
        "trusted prior-run evidence validation",
        "evidence production and branch-workflow reuse"
      ],
      "activation": {
        "state": "planned",
        "slice": "content-sensitive-validation-evidence"
      }
    },
    {
      "owner": "distributed validation risk",
      "root": "scripts/distributed-validation-risk",
      "entry": "scripts/distributed-validation-risk.mjs",
      "testRoot": "packages/tests/repo/distributed-validation-risk",
      "focusedCommand": "npm run test:distributed-validation-risk",
      "navigationMap": "scripts/distributed-validation-risk/README.md",
      "factContracts": [
        "scripts/plan-adaptation/adaptive-plan-record.mjs"
      ],
      "contractPaths": [
        ".github/workflows/hetzner-supported-distributed-manifests.yml"
      ],
      "controlFlowFamilies": [
        "changed-path risk classification",
        "structured plan requirement and manual override",
        "main-push Hetzner workflow selection"
      ],
      "activation": {
        "state": "planned",
        "slice": "risk-scoped-distributed-validation"
      }
    }
  ],
  "architecture": {
    "currentHypothesis": "Plan, style, review, and workflow rules exist as separate controls without one execution-time adaptation owner.",
    "intendedHypothesis": "A plan-adaptation capability owns rolling decisions while a separate repository-structure capability supplies structural facts.",
    "invalidatedAssumptions": [
      "A prose-only repository-structure skill can reliably make fresh agents reproduce exact owner-to-result navigation evidence; the frozen provenance run made a sound structural judgment but recovered only two of six required repository facts.",
      "Every guidance capability is a skill owner with a mirrored skill-named test root. Activating Task 9 proved that AGENTS.md is a distinct routing owner whose general-agent-guidance tests must not be disguised as publishing-plan-progress ownership.",
      "The planned PR-review command name check-pr-human-review was a valid executable name but not an exact thin sibling of scripts/pr-human-review; direct cutover required scripts/pr-human-review.mjs and no compatibility wrapper."
    ],
    "freshInitialReview": {
      "status": "complete",
      "reviewer": "/root/initial_architecture_review",
      "verdict": "pass",
      "evidence": "Fresh-context review passed on 2026-08-12 after two scoped correction rounds resolved exact Slice 2 ownership, legacy inventory and review bounds, canonical structural fact ownership, focused commands, navigation-map evidence, and terminology."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "03f690f3ae9d821876d50035ef7463def0985059",
    "affectedCodeDigest": "0f6e1a2f54bc8317cfb9ace52ca3138f83808ff31bdac789647d04ca358151b5",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "lifecycle-change",
      "invalid-assumption"
    ],
    "undeclaredChangedPaths": []
  },
  "checkpoint": {
    "outcome": "PR Human Review v2 and the Fast Governance Gate now form a reviewed content-aware review boundary and a phase-attributed early CI boundary. The gate preserves canonical plan, structure, review, and focused-test owners, remains below ten seconds across repeated trials, and blocks the broad Release Gate without duplicating it.",
    "learning": "The first broad branch failure was compatibility drift rather than a governance regression: the branch changed neither the headless bundle nor its test, and refreshed origin/main already raised the measured cap from 197 to 199 KiB. Merging origin/main and advancing the explicit diff base made that proof and the exact Governance Gate green. The next automation must therefore reuse evidence by build content and trusted run identity, not by head SHA, while distributed validation needs its own structured risk decision rather than an unconditional main-push trigger.",
    "structure": "Give validation evidence one owner at scripts/validation-evidence with the existing PR freshness classifier as an explicit fact contract and ownership of Branch Release Gate/reusable Release Gate orchestration. Give distributed validation risk a separate scripts/distributed-validation-risk owner in front of the existing Hetzner supported-manifest workflow. Neither owner may duplicate broad CI, the distributed runner, build-path classification, or architectural judgment.",
    "decision": "continue",
    "nextSlices": [
      "content-sensitive-validation-evidence",
      "risk-scoped-distributed-validation"
    ]
  },
  "structuralDispositions": [
    {
      "kind": "ownership-contract",
      "target": "scripts/repo-style-check/layout-rules.mjs density, prefix-clustering, and file-size facts",
      "disposition": "keep",
      "rationale": "Repo style remains canonical; repository structure consumes one exported fact contract and owns only topology and disposition policy."
    },
    {
      "kind": "ownership-contract",
      "target": "scripts/plan-adaptation/adaptive-plan-record.mjs capability declaration policy",
      "disposition": "split",
      "rationale": "Task 10 exposed capability declaration shape, planned topology, and exact contract ownership as one independent policy seam. adaptive-plan-capabilities.mjs now owns that policy while adaptive-plan-record.mjs retains record parsing, digests, and non-capability fields."
    },
    {
      "kind": "predecessor-path",
      "path": "scripts/check-pr-human-review.mjs",
      "disposition": "move",
      "destination": "scripts/pr-human-review.mjs",
      "owner": "PR human review",
      "rationale": "Review Record v2 directly replaces the v1 command with the canonical exact thin sibling entry and retains no compatibility wrapper."
    },
    {
      "kind": "predecessor-path",
      "path": "packages/tests/repo/pr-human-review-record-contract.test.ts",
      "disposition": "consolidate",
      "destination": "packages/tests/repo/pr-human-review/review-record-contract.test.ts",
      "owner": "PR human review",
      "rationale": "The v1 flat contract test moved into the declared mirrored PR-review test owner for the direct v2 cutover."
    },
    {
      "kind": "predecessor-path",
      "path": "packages/tests/repo/pr-human-review-validation.test.ts",
      "disposition": "consolidate",
      "destination": "packages/tests/repo/pr-human-review/review-record-v2.test.ts",
      "owner": "PR human review",
      "rationale": "The v1 flat validator tests were replaced by semantic v2 tests inside the declared mirrored owner."
    },
    {
      "kind": "predecessor-path",
      "path": "packages/tests/repo/legacy-review-stage-driver.test.ts",
      "disposition": "consolidate",
      "destination": "packages/tests/repo/pr-human-review/legacy-review-stage-integration.test.ts",
      "owner": "PR human review",
      "rationale": "Exact legacy-stage coverage now lives with the PR-review capability while preserving direct integration with the legacy scanner."
    }
  ],
  "freshStructuralReview": {
    "status": "complete",
    "failures": []
  },
  "coldNavigationEvidence": {
    "status": "passed",
    "summary": "After consolidation, a fresh reviewer located both canonical commands, every lifecycle and trust family, mutation/read-only/destructive exits, explicit cross-owner facts, failure paths, and mirrored tests without reading the tactical plan, design, history, or PR.",
    "probes": [
      {
        "capabilityOwner": "plan adaptation",
        "path": "scripts/plan-adaptation.mjs",
        "symbol": "runCommand"
      },
      {
        "capabilityOwner": "plan adaptation",
        "path": "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "symbol": "parseAdaptivePlanRecord"
      },
      {
        "capabilityOwner": "plan adaptation",
        "path": "scripts/plan-adaptation/adaptive-plan-policy.mjs",
        "symbol": "validateCheckpoint"
      },
      {
        "capabilityOwner": "plan adaptation",
        "path": "scripts/plan-adaptation/plan-adaptation-lifecycle.mjs",
        "symbol": "closeAdaptivePlan"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check.mjs",
        "symbol": "readInput"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check/repository-structure-check.mjs",
        "symbol": "checkRepositoryStructure"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check/repository-files.mjs",
        "symbol": "readRepositoryFiles"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check/capability-declarations.mjs",
        "symbol": "validateCapabilityDeclarations"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check/structural-dispositions.mjs",
        "symbol": "validateStructuralDispositions"
      },
      {
        "capabilityOwner": "repository structure",
        "path": "scripts/repo-structure-check/structure-exceptions.mjs",
        "symbol": "readStructureExceptions"
      },
      {
        "capabilityOwner": "general agent guidance",
        "path": "AGENTS.md",
        "symbol": "Rallar Agent Guide"
      }
    ]
  },
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
    },
    {
      "date": "2026-08-12",
      "decision": "consolidate",
      "summary": "The first horizon delivered independently reviewed plan-adaptation and repository-structure capabilities with exact entries, mirrored tests, fail-closed boundaries, content-sensitive facts, and passing focused/read-only governance checks.",
      "checkpointDigest": "ea7fed2f2c9e442eeaf30f4a82eb75e927a705f6206160f94bc1f29461c89a75"
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "The autonomous consolidation repaired both durable navigation maps, made repository structure's four control-flow and trust families explicit, restored truthful completed/current plan horizons, and passed an independent code review plus a fresh-context cold-navigation probe."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "The adaptive-plan skill reached deterministic GREEN and all three critical fresh-agent scenarios passed after observed command and consolidation loopholes were closed, but its new skill, evaluation, and shared discovery-contract paths remain visibly undeclared by the active record."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "Guidance capabilities now have an honest declaration shape, and the adaptive-plan execution skill, versioned evaluations, canonical result validator, focused tests, and plugin discovery contract are complete. All three critical fresh-agent scenarios pass all 23 required rubric dimensions, focused/read-only checks pass, and an independent behavior-horizon review has no open Critical or Important findings."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "The planned-capability lifecycle is complete and independently reviewed: planned owners reserve their scope without placeholder files, are disjoint from active and other planned topology roots, preserve active rename lineage, and must activate before completion or close-out. A separate CI regression correction also restored the adaptive evaluation validator to the repository input-contract standard without changing its API or results."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "The repository-structure skill, blind scenarios, portable evaluation contract, and provenance ledger were implemented, but Task 7 did not satisfy its behavior acceptance. Independent review rejected summarized evidence, and the replacement frozen campaign stopped correctly when its first assisted run recovered only two of six exact navigation facts despite making a reasonable structural decision."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "The organizing-repository-structure skill and automated navigation-evidence boundary now pass deterministic validation, five provenance-bound assisted micro-runs, all three critical full scenarios, and independent review with no Critical or Important findings. Exact navigation facts moved into repository-owned automation while agents retained coherent, reversible structural judgment."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "Task 9 removed duplicated execution, structure, test-scope, issue-startup, and publication rules and passed a provenance-bound 5+5 evaluation plus independent review. Task 10 added exact non-code contract ownership, closed active/planned fact-contract conflicts, and split capability policy from the oversized plan-record module with independent review passing."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "The corrective guidance-router slice now represents AGENTS.md as its own exact owner, includes router facts and cold navigation without authored-code rules, preserves skill declarations as a separate backward-compatible union, and passes independent review plus the 8.82-second aggregate governance path."
    },
    {
      "date": "2026-08-12",
      "decision": "amend",
      "summary": "PR Human Review Record v2 now directly replaces v1 through one exact thin command entry, one visible and metadata contract, content-sensitive initial/checkpoint/final validation, preserved trusted retained-legacy and candidate-report evidence, mirrored focused tests, and synchronized-PR workflow enforcement."
    },
    {
      "date": "2026-08-12",
      "decision": "continue",
      "summary": "PR Human Review v2 and the Fast Governance Gate now form a reviewed content-aware review boundary and a phase-attributed early CI boundary. The gate preserves canonical plan, structure, review, and focused-test owners, remains below ten seconds across repeated trials, and blocks the broad Release Gate without duplicating it."
    }
  ]
}
```
