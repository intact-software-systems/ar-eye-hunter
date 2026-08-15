# PR-Centered Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repository-tracked delivery bookkeeping with a live GitHub PR state contract that detects real conflicts first, isolates concurrent PRs, supports native approval/auto-merge and administrator merge, and performs no governance work after merge.

**Architecture:** GitHub owns remote delivery state. A small `pull-request-delivery` command reads the current PR and reduces it to one agent action without persisting remote identifiers. Existing CI is moved from feature-branch pushes to PR events with per-PR concurrency; active-plan and generic PR-record gates are retired while product, structure, retained-legacy, and default-branch safety checks remain.

**Tech Stack:** Node.js 24 ESM, Vitest, GitHub CLI, GitHub Actions, GitHub repository rulesets.

## Global Constraints

- The PR is the only governed delivery entity; do not introduce a commit-level approval entity.
- Do not add a GitHub App, private key, custom approval check, merge queue, or organization transfer.
- Do not persist PR numbers, SHAs, digests, check IDs, run IDs, review IDs, or mergeability snapshots in repository files.
- Query conflict/closed/merged state before broad validation or governance work.
- `BEHIND` alone must never request update-branch, merge-main, rebase, reapproval, or metadata refresh.
- Ordinary PRs must not modify shared files solely to record plan progress or completion.
- Native administrator merge is a supported role-based path; do not name a permanent person or contributor count.
- The final migration PR performs the one-time ruleset and auto-merge cutover before final approval, leaving no post-merge task.
- Preserve historical governance records as inert input unless a focused consumer test proves safe deletion; do not bulk-rewrite history.
- Tests assert observable state decisions, not incidental helper topology or copied source strings.

---

## File map

### Create

- `scripts/pull-request-delivery.mjs` — command entry for `status` and `ready`.
- `scripts/pull-request-delivery/derive-delivery-action.mjs` — pure PR-state reducer.
- `scripts/pull-request-delivery/read-pull-request.mjs` — one GitHub CLI read boundary.
- `scripts/pull-request-delivery/ready-pull-request.mjs` — idempotent mark-ready/auto-merge boundary.
- `scripts/pull-request-delivery/README.md` — owner, dataflow, failures, and command contract.
- `packages/tests/repo/pull-request-delivery/delivery-action.test.ts` — state-table behavior.
- `packages/tests/repo/pull-request-delivery/pull-request-command.test.ts` — CLI reads and mutations.
- `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts` — PR trigger, concurrency, and no-App contract.
- `scripts/repository-changes/read-git-changes.mjs` — generic changed-path reads extracted from the
  retired plan lifecycle.
- `packages/tests/repo/repository-changes/read-git-changes.test.ts` — generic Git-change behavior.
- `scripts/legacy-review/retained-legacy-registry.mjs` — durable retained-legacy registry parser.
- `scripts/legacy-review/validate-retained-legacy.mjs` — focused retained-legacy policy.
- `scripts/validation-evidence/build-affecting-tree.mjs` — transient CI content comparison with no
  PR-review dependency.

### Modify

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/workflows/branch-release-gate.yml`
- `.github/workflows/governance-gate.yml`
- `.github/workflows/release-gate.yml`
- `AGENTS.md`
- `.agents/skills/adaptive-plan-execution/SKILL.md`
- `.agents/skills/organizing-repository-structure/SKILL.md`
- `.agents/skills/publishing-plan-progress/SKILL.md`
- `.agents/skills/rallar-code-writing/SKILL.md`
- `.agents/skills/rallar-testing/SKILL.md`
- `.agents/skills/rallar-testing/references/test-commands.md`
- `docs/README.md`
- `docs/repo-human-style-guide.md`
- `plans/README.md`
- `package.json`
- `scripts/governance-gate/governance-gate-phases.mjs`
- `scripts/governance-gate/README.md`
- `scripts/governance-decisions.mjs`
- `scripts/governance-decisions/governance-decision-receipt-index.mjs`
- `scripts/repo-structure-check.mjs`
- `scripts/repo-structure-check/**`
- `scripts/distributed-validation-risk/**`
- `scripts/legacy-review/validate-supplied-evidence.mjs`
- `scripts/validation-evidence.mjs`
- `scripts/validation-evidence/**`
- `.agents/evaluations/adaptive-agent-execution/v1/**`
- `.agents/evaluations/organizing-repository-structure/v1/**`
- `packages/tests/repo/general-agent-guidance/**`
- `packages/tests/repo/adaptive-agent-execution/adaptive-agent-evaluation-contract.test.ts`
- `packages/tests/repo/adaptive-agent-execution/adaptive-agent-evaluation-result.test.ts`
- `packages/tests/repo/distributed-validation-risk/**`
- `packages/tests/repo/governance-decisions/**`
- `packages/tests/repo/governance-gate/**`
- `packages/tests/repo/github-actions-runtime-governance.test.ts`
- `packages/tests/repo/legacy-review.test.ts`
- `packages/tests/repo/repository-governance.test.ts`
- `packages/tests/repo/repo-structure-check/**`
- `packages/tests/repo/organizing-repository-structure/**`
- `packages/tests/repo/validation-evidence/**`

### Delete after replacements pass focused tests

- `.github/workflows/pr-human-review-record.yml`
- `docs/pr-human-review-record.md`
- `scripts/pr-human-review.mjs`
- `scripts/pr-human-review/**`
- `scripts/check-pr-human-review-legacy-stages.mjs`
- `scripts/plan-adaptation.mjs`
- `scripts/plan-adaptation/README.md`
- `scripts/plan-adaptation/plan-adaptation-lifecycle.mjs`
- `scripts/plan-adaptation/file-transaction.mjs`
- `scripts/repo-structure-check/capability-declarations.mjs`
- `scripts/repo-structure-check/navigation-evidence.mjs`
- `scripts/repo-structure-check/structural-dispositions.mjs`
- `packages/tests/repo/pr-human-review/**`
- `packages/tests/repo/plan-adaptation/**`
- `packages/tests/repo/adaptive-agent-execution/adaptive-plan-execution-contract.test.ts`

Historical `plans/*.md`, closure JSON, and `governance/decisions/*.json` files are not rewritten by
this migration. They become inert history. The small plan-record readers still required to verify
historical governance commits remain compatibility code, but no ordinary command or check creates or
updates a plan. Existing non-plan authenticated exception verification remains outside the ordinary
PR path.

---

## Task 1: Define the PR delivery state before adding GitHub effects

**Files:**

- Create: `scripts/pull-request-delivery/derive-delivery-action.mjs`
- Create: `packages/tests/repo/pull-request-delivery/delivery-action.test.ts`

**Interfaces:**

- Consumes: a normalized live PR snapshot with `state`, `merged`, `isDraft`, `baseRefName`,
  `defaultBranch`, `mergeable`, `mergeStateStatus`, `checks`, `reviewDecision`, and
  `autoMergeArmed`.
- Produces: `deriveDeliveryAction(pullRequest)` returning exactly one of `OPEN_DRAFT`, `WORK`,
  `STOP_CLOSED`, `DONE`, `STOP_WRONG_BASE`, `WAIT_GITHUB`, `REPAIR_CONFLICT`, `REPAIR_CHECK`,
  `WAIT_CI`, `AWAIT_REVIEW_OR_ADMIN_MERGE`, `ARM_AUTO_MERGE`, or `WAIT_MERGE`.

- [ ] **Step 1: Write the failing table test**

  Cover every result above. Include these non-negotiable cases:

  ```js
  {
    name: 'ignores a behind base when the PR remains mergeable',
    pullRequest: {
      state: 'OPEN', merged: false, isDraft: false,
      baseRefName: 'main', defaultBranch: 'main',
      mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND',
      checks: 'PASSING', reviewDecision: 'REVIEW_REQUIRED', autoMergeArmed: false,
    },
    expected: 'AWAIT_REVIEW_OR_ADMIN_MERGE',
  }
  ```

  ```js
  {
    name: 'reports the real conflict before check or review state',
    pullRequest: {
      state: 'OPEN', merged: false, isDraft: false,
      baseRefName: 'main', defaultBranch: 'main',
      mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
      checks: 'PENDING', reviewDecision: 'REVIEW_REQUIRED', autoMergeArmed: false,
    },
    expected: 'REPAIR_CONFLICT',
  }
  ```

  Assert that `merged` wins over stale failure fields and produces `DONE`.

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

  Run: `npx vitest run packages/tests/repo/pull-request-delivery/delivery-action.test.ts`

  Expected: FAIL because `derive-delivery-action.mjs` does not exist.

- [ ] **Step 3: Implement the pure reducer**

  Use direct ordered branches. Resolve terminal states first, then wrong base, draft, unknown,
  conflict, checks, review, and auto-merge. Do not accept a SHA, digest, plan, actor name, or PR
  number because none changes the decision.

- [ ] **Step 4: Run the focused test**

  Run: `npx vitest run packages/tests/repo/pull-request-delivery/delivery-action.test.ts`

  Expected: PASS.

- [ ] **Step 5: Review the representative dataflow**

  Confirm that one normalized PR snapshot enters one pure reducer and produces one visible action;
  there is no clock, filesystem, Git, GitHub, or environment dependency.

- [ ] **Step 6: Commit the pure state contract**

  ```bash
  git add -- scripts/pull-request-delivery/derive-delivery-action.mjs packages/tests/repo/pull-request-delivery/delivery-action.test.ts
  git commit -m "feat(governance): derive delivery from pull request state"
  ```

## Task 2: Add one idempotent command that reads the current PR

**Files:**

- Create: `scripts/pull-request-delivery.mjs`
- Create: `scripts/pull-request-delivery/read-pull-request.mjs`
- Create: `scripts/pull-request-delivery/ready-pull-request.mjs`
- Create: `scripts/pull-request-delivery/README.md`
- Create: `packages/tests/repo/pull-request-delivery/pull-request-command.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `gh pr view` for the PR associated with the current branch and `gh repo view` for the
  default branch.
- Produces: `npm run pr:delivery -- status` and `npm run pr:delivery -- ready`.
- Side effects: `ready` may run `gh pr ready` once when draft and, only after GitHub reports
  approval, `gh pr merge --auto --squash` once when auto-merge is available but unarmed. It never
  performs an immediate `--admin` merge.

- [ ] **Step 1: Write command-spy tests**

  Inject an `execFile` boundary and assert:

  - `status` uses one `gh pr view --json` call containing PR state, mergeability, review, checks,
    auto-merge, and base-ref fields;
  - no command asks for a SHA, plan path, digest, workflow run, reviewer, or PR number;
  - `ready` checks `REPAIR_CONFLICT` before mutations;
  - a draft PR uses at most `gh pr ready` followed by one state refresh;
  - a repeated `ready` on an already-ready/armed PR performs zero mutations;
  - missing approval returns `AWAIT_REVIEW_OR_ADMIN_MERGE` without arming auto-merge or
    fabricating evidence;
  - merged returns `DONE` without GitHub mutation;
  - closed-unmerged returns `STOP_CLOSED` without reopening.

- [ ] **Step 2: Run the command tests and confirm failure**

  Run: `npx vitest run packages/tests/repo/pull-request-delivery/pull-request-command.test.ts`

  Expected: FAIL because the command modules do not exist.

- [ ] **Step 3: Implement the GitHub read boundary**

  Normalize GitHub's `statusCheckRollup` into `PASSING`, `PENDING`, or `FAILING`. Keep PR URL and
  number only in command output. Do not return or write a governance evidence object.

- [ ] **Step 4: Implement `status` and `ready`**

  `status` prints the action, PR URL, and only the concrete blocker needed by the next actor.
  `ready` refreshes state after each permitted mutation and prints the final action. It arms
  auto-merge only after approval. A failed attempt to arm auto-merge must preserve the native
  GitHub error and finish at
  `AWAIT_REVIEW_OR_ADMIN_MERGE` when administrator action is the available path.

- [ ] **Step 5: Add the package command and navigation map**

  Add:

  ```json
  "pr:delivery": "node scripts/pull-request-delivery.mjs",
  "test:pull-request-delivery": "vitest run packages/tests/repo/pull-request-delivery"
  ```

  Document the entry, reducer, GitHub boundary, mutation boundary, output states, and the rule that
  `BEHIND` alone is ignored.

- [ ] **Step 6: Run focused tests and smoke help**

  Run:

  ```bash
  npx vitest run packages/tests/repo/pull-request-delivery
  npm run pr:delivery -- --help
  ```

  Expected: PASS, and help lists only `status` and `ready`.

- [ ] **Step 7: Commit the PR command**

  ```bash
  git add -- package.json scripts/pull-request-delivery.mjs scripts/pull-request-delivery packages/tests/repo/pull-request-delivery/pull-request-command.test.ts
  git commit -m "feat(governance): add pull request delivery command"
  ```

## Task 3: Replace tracked plan/review metadata with semantic PR intent

**Files:**

- Modify: `.github/PULL_REQUEST_TEMPLATE.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/adaptive-plan-execution/SKILL.md`
- Modify: `.agents/skills/organizing-repository-structure/SKILL.md`
- Modify: `.agents/skills/publishing-plan-progress/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `docs/README.md`
- Modify: `docs/repo-human-style-guide.md`
- Modify: `plans/README.md`
- Modify: `packages/tests/repo/general-agent-guidance/**`
- Modify: `.agents/evaluations/adaptive-agent-execution/v1/**`
- Modify: `packages/tests/repo/adaptive-agent-execution/adaptive-agent-evaluation-contract.test.ts`
- Modify: `packages/tests/repo/adaptive-agent-execution/adaptive-agent-evaluation-result.test.ts`
- Modify: `packages/tests/repo/repository-governance.test.ts`
- Delete: `docs/pr-human-review-record.md`
- Delete: `packages/tests/repo/adaptive-agent-execution/adaptive-plan-execution-contract.test.ts`

**Interfaces:**

- Consumes: an agent's current working plan and the live PR.
- Produces: a concise PR body with Goal, Changes, Acceptance, Validation, Risk and rollback, and
  Follow-up; large work may link a durable design document.

- [ ] **Step 1: Rewrite guidance contract tests first**

  Assert all routed guidance agrees on these statements:

  - the PR is the remote delivery entity;
  - the agent keeps only the next two useful implementation slices concrete;
  - material evidence changes the working plan, while base movement alone does not;
  - no tracked active-plan record, digest, catalog, receipt, or PR metadata fence is required;
  - open one draft PR early for multi-slice work;
  - run `pr:delivery status` before final validation and `pr:delivery ready` once at handoff;
  - `DONE` permits no post-merge governance work.

  Remove tests that demand exact run identities, build-tree digests, plan commands, or tracked
  evidence ledgers from ordinary publication.

  Update the adaptive-agent scenarios and rubric to test PR-state-first conflict handling, a
  two-slice working horizon, proportional validation, and the rule that base movement alone is not
  work. Evaluation infrastructure may retain its own reproducibility digests; those are test-fixture
  internals and must not become ordinary PR inputs.

- [ ] **Step 2: Run the guidance tests and confirm they fail against old guidance**

  Run:

  ```bash
  npx vitest run packages/tests/repo/general-agent-guidance packages/tests/repo/repository-governance.test.ts
  ```

  Expected: FAIL on the old plan-adaptation and PR-record requirements.

- [ ] **Step 3: Replace the PR template**

  Use only these visible headings and prompts:

  ```markdown
  ## Goal

  ## Changes

  ## Acceptance

  ## Validation

  ## Risk and rollback

  ## Follow-up
  ```

  Include `Follow-up: None` as the default. Do not include JSON, identifiers, copied changed paths,
  reviewer declarations, stage history, or completion metadata.

- [ ] **Step 4: Rewrite the adaptive and publication skills**

  Preserve planning judgment, two-slice focus, compatibility review only when behavior is affected,
  proportional validation, safe Git publication, and final handoff. Replace every ordinary
  `plan:adapt`, receipt, digest, and closure instruction with working-plan judgment plus live PR
  state. Explicitly order conflict status before broad validation.

- [ ] **Step 5: Update root and review guidance**

  Keep default-branch commit/push permission and retained-production-legacy approval rules. Remove
  plan completion through `governance:decide` from the ordinary PR path. State that any remaining
  authenticated exception authority is separate and cannot be used as PR completion evidence.

- [ ] **Step 6: Make `plans/` inert history**

  Rewrite `plans/README.md` so existing documents are reference material, not a live catalog. Do not
  list active status, capacity, mutable ownership, or commands. Do not move or rewrite historical
  plan files in this migration.

- [ ] **Step 7: Run guidance and repository-governance tests**

  Run:

  ```bash
  npx vitest run packages/tests/repo/general-agent-guidance packages/tests/repo/repository-governance.test.ts
  npm run test:repo-governance
  ```

  Expected: focused tests PASS. The broad command may still fail on old plan/PR-record modules until
  Tasks 4 and 5 remove their consumers; record only those expected failures.

- [ ] **Step 8: Commit the semantic PR contract**

  ```bash
  git add -- .github/PULL_REQUEST_TEMPLATE.md AGENTS.md .agents/skills/adaptive-plan-execution .agents/skills/organizing-repository-structure .agents/skills/publishing-plan-progress .agents/skills/rallar-code-writing .agents/skills/rallar-testing .agents/evaluations/adaptive-agent-execution docs/README.md docs/repo-human-style-guide.md docs/pr-human-review-record.md plans/README.md packages/tests/repo/general-agent-guidance packages/tests/repo/adaptive-agent-execution packages/tests/repo/repository-governance.test.ts
  git commit -m "docs(governance): make pull requests the delivery authority"
  ```

## Task 4: Decouple useful checks, then retire active plan enforcement

**Files:**

- Create: `scripts/repository-changes/read-git-changes.mjs`
- Create: `packages/tests/repo/repository-changes/read-git-changes.test.ts`
- Delete: `scripts/plan-adaptation.mjs`
- Delete: `scripts/plan-adaptation/README.md`
- Delete: `scripts/plan-adaptation/plan-adaptation-lifecycle.mjs`
- Delete: `scripts/plan-adaptation/file-transaction.mjs`
- Delete: `packages/tests/repo/plan-adaptation/**`
- Delete: `scripts/repo-structure-check/capability-declarations.mjs`
- Delete: `scripts/repo-structure-check/navigation-evidence.mjs`
- Delete: `scripts/repo-structure-check/structural-dispositions.mjs`
- Modify: `scripts/repo-structure-check.mjs`
- Modify: `scripts/repo-structure-check/**`
- Modify: `packages/tests/repo/repo-structure-check/**`
- Modify: `.agents/skills/organizing-repository-structure/SKILL.md`
- Modify: `.agents/evaluations/organizing-repository-structure/v1/**`
- Modify: `packages/tests/repo/organizing-repository-structure/**`
- Modify: `scripts/distributed-validation-risk.mjs`
- Modify: `scripts/distributed-validation-risk/**`
- Modify: `packages/tests/repo/distributed-validation-risk/**`
- Modify: `scripts/governance-decisions.mjs`
- Modify: `scripts/governance-decisions/governance-decision-receipt-index.mjs`
- Modify: `packages/tests/repo/governance-decisions/**`
- Modify: `scripts/governance-gate/governance-gate-phases.mjs`
- Modify: `scripts/governance-gate/README.md`
- Modify: `packages/tests/repo/governance-gate/**`
- Modify: `.github/workflows/deploy.yml`
- Modify: `package.json`

**Interfaces:**

- Consumes: the current worktree, one explicit/default merge base, and focused check commands.
- Produces: generic Git change reads, diff-scoped repository structure findings, path-based
  distributed-risk selection, and one read-only local governance gate with no active-plan catalog.

- [ ] **Step 1: Change governance-gate tests**

  Assert its phase list contains only focused, read-only repository policy checks. It must reject a
  phase command beginning with `test:` and must not contain `plan-adaptation`, `pr-human-review`,
  `governance:decide`, GitHub network access, or a mutable output path.

- [ ] **Step 2: Run the focused gate tests and confirm failure**

  Run: `npm run test:governance-gate`

  Expected: FAIL because the current phases invoke active-plan and PR-review test suites.

- [ ] **Step 3: Extract generic Git change reads**

  Move `readChangedPaths` and `readChangedPathsBetweenRevisions` into
  `scripts/repository-changes/read-git-changes.mjs` without plan parsing, scope assignment, digests,
  or catalog access. Update repository structure, distributed risk, validation, and governance
  decision consumers to import the generic module. Preserve changed-path behavior with focused
  tests before removing the old export.

- [ ] **Step 4: Make repository structure diff-scoped**

  Replace catalog-selected bases, capability reservations, computed plan facts, and tracked
  structural dispositions with the explicit `--base` value or `origin/main` and the actual changed
  tree. Keep deterministic singleton, redundant-chain, exception-registry, and changed-structure
  findings. Remove the plan-owned navigation-evidence command; structural judgment is recorded in
  the PR review, while the checker reports reproducible facts directly.

  Update `organizing-repository-structure` so it reads owners and entries from the changed code and
  navigation maps, runs `npm run check:repo-structure -- --base <base>` when a non-default base is
  needed, and never writes a structural disposition into a plan.

- [ ] **Step 5: Make distributed validation path-based**

  Remove active-plan documents and plan IDs from distributed-risk input and output. Keep automatic
  selection for the existing distributed-risk path families. A PR explains any additional manually
  selected distributed validation semantically; no plan record is parsed.

- [ ] **Step 6: Remove active-plan phases and commands**

  Delete `plan:adapt`, `check:plan-adaptation`, `test:plan-adaptation`,
  `test:adaptive-plan-execution`, and `test:adaptive-governance` from `package.json`. Remove the
  corresponding deploy and governance-gate invocations. Keep repository-structure checking as its
  independently owned read-only command.

- [ ] **Step 7: Delete the active-plan lifecycle and coupled tests**

  Delete the CLI, lifecycle writer, transaction helper, and lifecycle tests. Leave the minimal
  compatibility readers needed to verify historical governance commits, together with their
  governance-decision regression coverage. No command may initialize, adapt, close, postpone,
  resume, enumerate, or enforce active plans. Replace governance-decision test setup that imported
  `initAdaptivePlan` with a local immutable historical-record fixture; production verification may
  read the legacy schema but may not call the deleted lifecycle.

- [ ] **Step 8: Run focused tests**

  Run:

  ```bash
  npm run test:governance-gate
  npm run check:repo-structure
  npm run test:distributed-validation-risk
  npm run test:governance-decisions
  npx vitest run packages/tests/repo/repository-changes packages/tests/repo/repo-structure-check packages/tests/repo/organizing-repository-structure
  rg -n "plan:adapt|check:plan-adaptation|plan-adaptation-v1" package.json scripts .github AGENTS.md .agents/skills
  ```

  Expected: tests PASS; the search returns no active command or ordinary agent instruction.
  Compatibility readers may still recognize `plan-adaptation-v1` solely while verifying historical
  commits and must have no write or merge-gate caller.

- [ ] **Step 9: Commit active-plan retirement**

  ```bash
  git add -A -- package.json .github/workflows/deploy.yml .agents/skills/organizing-repository-structure .agents/evaluations/organizing-repository-structure scripts/plan-adaptation.mjs scripts/plan-adaptation scripts/repository-changes scripts/repo-structure-check.mjs scripts/repo-structure-check scripts/distributed-validation-risk.mjs scripts/distributed-validation-risk scripts/governance-decisions.mjs scripts/governance-decisions packages/tests/repo/plan-adaptation packages/tests/repo/repository-changes packages/tests/repo/repo-structure-check packages/tests/repo/organizing-repository-structure packages/tests/repo/distributed-validation-risk packages/tests/repo/governance-decisions scripts/governance-gate packages/tests/repo/governance-gate
  git commit -m "refactor(governance): retire tracked active plan state"
  ```

## Task 5: Remove generic PR evidence while preserving meaningful legacy review

**Files:**

- Delete: `.github/workflows/pr-human-review-record.yml`
- Delete: `scripts/pr-human-review.mjs`
- Delete: `scripts/pr-human-review/**`
- Delete: `scripts/check-pr-human-review-legacy-stages.mjs`
- Delete: `packages/tests/repo/pr-human-review/**`
- Create: `scripts/legacy-review/retained-legacy-registry.mjs`
- Create: `scripts/legacy-review/validate-retained-legacy.mjs`
- Create: `scripts/validation-evidence/build-affecting-tree.mjs`
- Modify: `scripts/legacy-review/validate-supplied-evidence.mjs`
- Modify: `packages/tests/repo/legacy-review.test.ts`
- Modify: `scripts/validation-evidence/**`
- Modify: `packages/tests/repo/validation-evidence/**`
- Modify: `scripts/governance-gate/governance-gate-phases.mjs`
- Modify: `packages/tests/repo/governance-gate/**`
- Modify: `package.json`

**Interfaces:**

- Consumes: changed production paths and the durable production-legacy exception registry only when
  affected code retains legacy.
- Produces: focused legacy findings; no general PR-review record.

- [ ] **Step 1: Add retained-legacy regression tests before deletion**

  Preserve tests that reject an unapproved newly retained production-legacy item and accept removed,
  resolved, minimized-boundary, or already registered retained items. Replace the PR JSON-fence
  fixture with direct semantic legacy inputs owned by `legacy-review`.

- [ ] **Step 2: Run the legacy tests and confirm the old coupling**

  Run: `npx vitest run packages/tests/repo/legacy-review.test.ts`

  Expected: FAIL after the fixture stops providing `pr-human-review-record-v2`.

- [ ] **Step 3: Move the useful validation to its existing owner**

  Make `legacy-review` read only the changed production surface and durable exception registry. It
  must not require general PR metadata, plan status, reviewer identity, SHA copying, or a final
  evidence ledger. A genuinely new retained exception remains a meaningful shared policy change and
  may require administrator approval.

  Move the generic build-affecting-tree comparison used by transient CI reuse to
  `scripts/validation-evidence/build-affecting-tree.mjs`. It compares content for CI efficiency but
  does not interpret review or approval and does not persist to the repository.

- [ ] **Step 4: Delete the generic review workflow and parser**

  Remove the PR Human Review Record command, workflow, docs, metadata fence, and tests. Remove its
  package scripts and broad repo-governance suite entries.

  Add:

  ```json
  "test:legacy-review": "vitest run packages/tests/repo/legacy-review.test.ts"
  ```

- [ ] **Step 5: Run focused checks**

  Run:

  ```bash
  npm run test:legacy-review
  npm run test:governance-gate
  rg -n "pr-human-review-record-v2|PR Human Review Record|test:pr-human-review" .github scripts package.json AGENTS.md .agents docs
  ```

  Expected: tests PASS and no active ordinary-delivery reference remains. Historical design/plan
  documents may contain the old term and are not executable consumers.

- [ ] **Step 6: Commit generic PR-record removal**

  ```bash
  git add -A -- package.json .github/workflows/pr-human-review-record.yml scripts/pr-human-review.mjs scripts/pr-human-review scripts/check-pr-human-review-legacy-stages.mjs scripts/legacy-review scripts/validation-evidence packages/tests/repo/pr-human-review packages/tests/repo/legacy-review.test.ts packages/tests/repo/validation-evidence scripts/governance-gate packages/tests/repo/governance-gate
  git commit -m "refactor(governance): remove generic pull request evidence records"
  ```

## Task 6: Move CI from branch pushes to isolated PR runs

**Files:**

- Modify: `.github/workflows/branch-release-gate.yml`
- Modify: `.github/workflows/governance-gate.yml`
- Modify: `.github/workflows/release-gate.yml`
- Modify: `scripts/validation-evidence.mjs`
- Modify: `scripts/validation-evidence/**`
- Modify: `packages/tests/repo/validation-evidence/**`
- Modify: `packages/tests/repo/github-actions-runtime-governance.test.ts`
- Create: `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`

**Interfaces:**

- Consumes: `pull_request` event state and the candidate tree.
- Produces: stable required check `Branch Release Gate result` for the current PR.

- [ ] **Step 1: Write failing workflow contract tests**

  Assert:

  - `branch-release-gate.yml` triggers on `pull_request` opened, synchronize, reopened, and
    ready-for-review;
  - its concurrency group includes `${{ github.event.pull_request.number }}` and
    `cancel-in-progress: true`;
  - no repository-wide concurrency group exists;
  - the workflow never handles `merge_group` and never references a Source Approval App;
  - the checkout and changed-range inputs use PR context;
  - the stable result job remains `Branch Release Gate result`;
  - no workflow writes a plan, receipt, PR body, comment, branch commit, or governance artifact back
    to the repository.

- [ ] **Step 2: Run workflow tests and confirm failure**

  Run:

  ```bash
  npx vitest run packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts packages/tests/repo/github-actions-runtime-governance.test.ts packages/tests/repo/validation-evidence
  ```

  Expected: FAIL because Branch Release Gate currently uses `push` and branch-oriented evidence.

- [ ] **Step 3: Change Branch Release Gate to PR events**

  Add per-PR concurrency. Use the event base SHA/ref for affected-range checks and the checked-out
  candidate for validation. Keep permissions read-only. Do not add `pull_request_target`, secrets,
  App credentials, or candidate-controlled privileged operations.

- [ ] **Step 4: Make transient validation evidence PR-aware**

  Where validation reuse remains valuable, bind it to the current PR run and keep it as a GitHub
  artifact only. Its internal head value may associate a check with candidate content, but it must
  never become a user/agent input or tracked governance record. Delete reuse code if its PR rewrite
  is more complex than rerunning the affected validation it saves.

- [ ] **Step 5: Put PR-state preflight before broad validation**

  The agent command, not CI, owns the remote conflict preflight. Guidance must require
  `npm run pr:delivery -- status` immediately before selecting final validation. CI still runs when
  GitHub schedules it, but an agent never starts a manual broad rerun before checking conflict state.

- [ ] **Step 6: Run focused workflow tests**

  Run:

  ```bash
  npx vitest run packages/tests/repo/pull-request-delivery packages/tests/repo/github-actions-runtime-governance.test.ts packages/tests/repo/validation-evidence
  ```

  Expected: PASS.

- [ ] **Step 7: Commit PR-isolated CI**

  ```bash
  git add -- .github/workflows/branch-release-gate.yml .github/workflows/governance-gate.yml .github/workflows/release-gate.yml scripts/validation-evidence.mjs scripts/validation-evidence packages/tests/repo/validation-evidence packages/tests/repo/github-actions-runtime-governance.test.ts packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts
  git commit -m "ci(governance): isolate release validation by pull request"
  ```

## Task 7: Prove cross-PR isolation and both merge paths

**Files:**

- Modify: `packages/tests/repo/pull-request-delivery/delivery-action.test.ts`
- Modify: `packages/tests/repo/pull-request-delivery/pull-request-command.test.ts`
- Modify: `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`
- Modify: `packages/tests/repo/repository-governance.test.ts`

**Interfaces:**

- Consumes: two unrelated PR snapshots and two runs of the same PR.
- Produces: evidence that unrelated PRs share no mutable governance state while same-PR superseded CI
  is cancelled.

- [ ] **Step 1: Add the isolation fixture**

  Create PR 101 and PR 102 snapshots with different body content and source paths. Assert status for
  either PR does not read or write the other's number, state, files, or workflow group. Assert the
  only concurrency collision is between two runs whose PR number is the same.

- [ ] **Step 2: Add collaborative-path fixtures**

  Prove `REVIEW_REQUIRED` produces `AWAIT_REVIEW_OR_ADMIN_MERGE`, `APPROVED` plus unarmed produces
  `ARM_AUTO_MERGE`, and approved plus armed produces `WAIT_MERGE`.

- [ ] **Step 3: Add administrator-path fixtures**

  Prove an unapproved open PR never claims approval, and a later GitHub snapshot with `merged: true`
  produces `DONE` regardless of the earlier review/check state. Assert no receipt or cleanup command
  follows `DONE`.

- [ ] **Step 4: Add real-versus-synthetic conflict tests**

  Prove `BEHIND` plus `MERGEABLE` causes no repair, while `CONFLICTING` always causes
  `REPAIR_CONFLICT` before pending checks or reviews.

- [ ] **Step 5: Run the complete focused governance suite**

  Run:

  ```bash
  npx vitest run packages/tests/repo/pull-request-delivery packages/tests/repo/governance-gate packages/tests/repo/general-agent-guidance packages/tests/repo/legacy-review.test.ts packages/tests/repo/repository-governance.test.ts
  ```

  Expected: PASS.

- [ ] **Step 6: Commit merge-path and isolation coverage**

  ```bash
  git add -- packages/tests/repo/pull-request-delivery packages/tests/repo/repository-governance.test.ts
  git commit -m "test(governance): cover isolated pull request delivery paths"
  ```

## Task 8: Validate, cut over settings, and hand the migration PR to GitHub

**Files:**

- Modify only if tests find a real defect in files already owned by Tasks 1–7.

**Interfaces:**

- Consumes: the migration PR, current repository settings, ruleset `15939552`, and final validation.
- Produces: one ready PR with native auto-merge available after approval, loose required checks,
  role-based admin bypass, and no post-merge governance work.

- [ ] **Step 1: Run local validation after checking PR state first**

  Run:

  ```bash
  npm run pr:delivery -- status
  npm run test:pull-request-delivery
  npm run test:governance-gate
  npm run test:legacy-review
  npm run test:repo-governance
  npm run check:repo-structure
  npm run check:repo-style
  npm run test:ci
  ```

  Expected: `status` does not report `REPAIR_CONFLICT`; all applicable checks PASS. If a real conflict
  exists, stop before the remaining commands, repair source, push, and restart from `status` without
  editing governance metadata.

- [ ] **Step 2: Inspect the live repository settings read-only**

  Run:

  ```bash
  gh repo view --json nameWithOwner,defaultBranchRef,isInOrganization
  gh api repos/{owner}/{repo} --jq '{allow_auto_merge,default_branch}'
  gh api repos/{owner}/{repo}/rulesets/15939552
  ```

  Expected before cutover: repository `intact-software-systems/ar-eye-hunter`, default `main`,
  auto-merge currently disabled, and role-based administrator bypass present. Re-resolve these facts
  during execution; do not assume they stayed unchanged.

- [ ] **Step 3: Prepare and review the exact settings mutation before applying it**

  Construct the complete ruleset payload from the live response. Its intended delta is:

  - condition include becomes `refs/heads/main` rather than `~ALL`;
  - administrator `RepositoryRole` bypass remains role-based and `always`;
  - pull-request approval count remains one, code-owner review remains enabled, stale dismissal
    remains false, and last-push approval remains false;
  - deletion, non-fast-forward, and linear-history protection remain;
  - broad restrict-update/restrict-creation rules are removed from ordinary contributor PR merges;
  - required status check `Branch Release Gate result` is added with
    `strict_required_status_checks_policy: false`.

  Show the exact repository, ruleset ID, current payload, proposed payload, and rollback payload to
  the owner and obtain one explicit approval for these external setting changes. This approval occurs
  before the final PR decision, never after merge.

- [ ] **Step 4: Apply and verify the one-time cutover**

  Enable repository auto-merge with the approved repository PATCH. Update ruleset `15939552` with the
  approved full payload. Read both endpoints again and fail closed if any field differs. Do not create
  an App, environment, secret, webhook, merge queue, or organization transfer.

- [ ] **Step 5: Run the readiness command once**

  Run: `npm run pr:delivery -- ready`

  Expected:

  - collaborative PR before approval: ready, with auto-merge unarmed so administrator merge stays
    immediate;
  - collaborative PR after approval: `ready` arms auto-merge once;
  - current solo/admin-authored PR: `AWAIT_REVIEW_OR_ADMIN_MERGE` when independent approval is
    unavailable; the administrator can merge manually;
  - conflict: `REPAIR_CONFLICT` and no readiness mutation;
  - merged: `DONE` and no mutation.

- [ ] **Step 6: Final PR decision and terminal behavior**

  Request normal GitHub review when another authorized reviewer is available. Otherwise report that
  the PR is ready for administrator merge. After GitHub reports `merged`, run no plan close, receipt,
  archive, rebase, check refresh, settings change, or governance commit. The next observation of the
  PR is `DONE`.

---

## Acceptance matrix

| Scenario                       | Required result                      | Forbidden work                                      |
| ------------------------------ | ------------------------------------ | --------------------------------------------------- |
| `main` moved, PR mergeable     | Continue current PR state            | rebase, update branch, reapproval, digest refresh   |
| Real source conflict           | `REPAIR_CONFLICT` first              | ten minutes of governance before discovery          |
| Checks pending                 | `WAIT_CI`                            | local evidence ledger                               |
| Checks failed                  | `REPAIR_CHECK`                       | plan metadata edits                                 |
| Approval available             | arm native auto-merge after approval | custom approval App/check                           |
| Approval unavailable           | `AWAIT_REVIEW_OR_ADMIN_MERGE`        | fake approval or receipt                            |
| Administrator merges           | `DONE`                               | retroactive proof that bypassed requirements passed |
| PR merged                      | `DONE`                               | any post-merge governance mutation                  |
| Two unrelated PRs              | independent PR bodies and CI groups  | shared plan/status/catalog mutation                 |
| Two PRs edit same product code | report real Git conflict             | label conflict as governance freshness              |

## Completion criteria

- The old low-friction/App/merge-queue draft artifacts are absent.
- The new implementation contains no Source Approval App, exact-source check, merge queue,
  organization transfer, or new credential.
- Agents and scripts derive action from the live PR and detect conflicts first.
- Active plan and generic PR-record enforcement are absent from ordinary delivery.
- Concurrent PRs do not share mutable governance state or global CI serialization.
- Branch Release Gate is PR-triggered, per-PR concurrent, read-only, and required in loose mode.
- Native collaborative auto-merge and role-based administrator merge are both verified paths.
- A merged PR is terminal and causes zero agent or human governance work.
