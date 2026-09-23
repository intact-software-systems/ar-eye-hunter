# Hosted Rallar Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the controller, the dispatch helper, the Actions materializers,
and the distributed-validation risk command under `scripts/hosted-rallar/` as
one fleet use-case, and delete the old paths in the same change.

**Architecture:** Three siblings. `scripts/hosted-rallar/controller/` is the
directory workflows copy onto the VM, so Actions scripts and the risk command
stay outside it. Risk matchers are translated onto the new paths. The set of
paths that select the deployment-runner family stays the same size: the
headless matrix planner and the risk command's own path stay unclassified.

**Tech Stack:** Git, Node, Vitest, GitHub Actions workflow YAML, shell.

## Global Constraints

- Hard cutover. Update every live caller and delete `scripts/hetzner/`,
  `scripts/github-actions/`, and `scripts/distributed-validation-risk.mjs` plus
  its folder. Leave no wrapper.
- Move `scripts/hetzner/controller/` as one directory. Shell scripts source
  siblings by relative path. Do not split that directory.
- Leave historical text unchanged under `plans/` (except this directory),
  `playground/`, and `docs/superpowers/plans/`.
- Translate matchers. Do not classify
  `scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs` or
  `scripts/hosted-rallar/distributed-validation-risk.mjs` as deployment-runner.
  Those paths are unclassified today.
- This slice depends on slice 1 only in the sense that both are separate pull
  requests. It does not edit `scripts/perf/`.

---

### Task 1: Move the fleet directories

**Files:**

- Move `scripts/hetzner/controller/` to `scripts/hosted-rallar/controller/`.
- Move `scripts/hetzner/dispatch-distributed-recipe.sh` to
  `scripts/hosted-rallar/dispatch-distributed-recipe.sh`.
- Move `scripts/github-actions/` to `scripts/hosted-rallar/actions/`. That
  directory contains:
  - `hetzner-operation-report.schema.json`
  - `hetzner-run-manifest-scope.mjs`
  - `materialize-hetzner-run-manifest.mjs`
  - `plan-github-free-headless-matrix.mjs`
  - `validate-hetzner-shared-preparation.mjs`
  - `write-hetzner-operation-report.mjs`
- Move `scripts/distributed-validation-risk.mjs` to
  `scripts/hosted-rallar/distributed-validation-risk.mjs`.
- Move `scripts/distributed-validation-risk/` to
  `scripts/hosted-rallar/distributed-validation-risk/`.

- [ ] **Step 1: Move the four owners**

```bash
mkdir -p scripts/hosted-rallar
git mv scripts/hetzner/controller scripts/hosted-rallar/controller
git mv scripts/hetzner/dispatch-distributed-recipe.sh \
  scripts/hosted-rallar/dispatch-distributed-recipe.sh
rmdir scripts/hetzner
git mv scripts/github-actions scripts/hosted-rallar/actions
git mv scripts/distributed-validation-risk.mjs \
  scripts/hosted-rallar/distributed-validation-risk.mjs
git mv scripts/distributed-validation-risk \
  scripts/hosted-rallar/distributed-validation-risk
```

- [ ] **Step 2: Fix the import that used to reach `scripts/repository-changes/`**

In `scripts/hosted-rallar/distributed-validation-risk/read-distributed-validation-input.mjs`,
replace:

```js
from '../repository-changes/read-git-changes.mjs'
```

with:

```js
from '../../repository-changes/read-git-changes.mjs'
```

The entry file
`scripts/hosted-rallar/distributed-validation-risk.mjs` keeps its
`./distributed-validation-risk/` imports. Actions files keep their imports
inside `actions/`.

- [ ] **Step 3: Rewrite path strings that moved with the files**

In the moved controller README, dispatch script, and shell comments, replace:

- `scripts/hetzner/controller` with `scripts/hosted-rallar/controller`
- `scripts/hetzner/dispatch-distributed-recipe.sh` with
  `scripts/hosted-rallar/dispatch-distributed-recipe.sh`

Known strings:

- `scripts/hosted-rallar/controller/README.md` scp source and the dispatch
  helper sentence
- `scripts/hosted-rallar/dispatch-distributed-recipe.sh` usage line
- comments in `controller/09-start-headless-workers.sh` and
  `controller/rallar-public-spa-env.sh`

In `scripts/hosted-rallar/distributed-validation-risk/README.md`, replace
`scripts/distributed-validation-risk` with
`scripts/hosted-rallar/distributed-validation-risk` in the navigation map and
the prose links.

---

### Task 2: Translate the deployment-runner matchers

**Files:**

- Modify
  `scripts/hosted-rallar/distributed-validation-risk/distributed-validation-risk.mjs`.
- Modify `packages/tests/repo/distributed-validation-risk/distributed-validation-risk.test.ts`.

- [ ] **Step 1: Replace `isDeploymentRunnerPath`**

```js
function isDeploymentRunnerPath(changedPath) {
    return (
        deploymentWorkflowPaths.has(changedPath) ||
        changedPath.startsWith('.github/workflows/hetzner-') ||
        isWithin(changedPath, 'scripts/hosted-rallar/controller') ||
        changedPath === 'scripts/hosted-rallar/dispatch-distributed-recipe.sh' ||
        /^scripts\/hosted-rallar\/actions\/[^/]*hetzner[^/]*$/u.test(changedPath) ||
        isWithin(changedPath, 'apps/rallar-black-box/manifests/hetzner')
    );
}
```

`deploymentWorkflowPaths` still contains
`.github/workflows/deploy-hetzner-controller.yml`. Workflow files whose names
start with `hetzner-` stay selected through the existing prefix.

- [ ] **Step 2: Update existing fixtures to the new paths**

In `distributed-validation-risk.test.ts`:

- Change `scripts/hetzner/controller/08-rollout-controller.sh` to
  `scripts/hosted-rallar/controller/08-rollout-controller.sh` in the
  `selects $family for $path` table and in `classifies a deleted risk path`.
- Keep the expected family as `deployment-runner` and keep `selected: true`.

- [ ] **Step 3: Add fixtures that prove the matcher did not widen**

Add these paths to the `keeps unrelated path cheap` table:

```text
scripts/hosted-rallar/actions/plan-github-free-headless-matrix.mjs
scripts/hosted-rallar/distributed-validation-risk.mjs
```

Add this path to the `selects $family for $path` table with family
`deployment-runner`:

```text
scripts/hosted-rallar/actions/materialize-hetzner-run-manifest.mjs
```

- [ ] **Step 4: Point the CLI test at the moved entry and run the risk tests**

In `packages/tests/repo/distributed-validation-risk/distributed-validation-risk-cli.test.ts`,
replace `scripts/distributed-validation-risk.mjs` with
`scripts/hosted-rallar/distributed-validation-risk.mjs`.

```bash
npx vitest run packages/tests/repo/distributed-validation-risk
```

Expected: PASS.

---

### Task 3: Retarget workflows, tests, skills, and the legacy scanner

**Files:**

- Modify workflows:
  - `.github/workflows/deploy-hetzner-controller.yml`
  - `.github/workflows/hetzner-distributed-recipe-runner.yml`
  - `.github/workflows/hetzner-headless-browsers.yml`
  - `.github/workflows/hetzner-supported-distributed-manifests.yml`
  - `.github/workflows/github-free-distributed-recipe.yml`
- Modify tests:
  - `packages/tests/hetzner/**`
  - `packages/tests/repo/distributed-validation-risk/**`
  - `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`
- Modify live docs and skills:
  - `.agents/skills/rallar-hetzner-ops/SKILL.md`
  - `.agents/skills/rallar-hetzner-ops/references/github-action-workflow.md`
  - `docs/rallar-hetzner-distributed-recipes.md`
- Modify `scripts/legacy-review/scan-changed-production.mjs`.

- [ ] **Step 1: Apply the path replacements**

| Old prefix                                       | New prefix                                             |
| ------------------------------------------------ | ------------------------------------------------------ |
| `scripts/hetzner/controller`                     | `scripts/hosted-rallar/controller`                     |
| `scripts/hetzner/dispatch-distributed-recipe.sh` | `scripts/hosted-rallar/dispatch-distributed-recipe.sh` |
| `scripts/github-actions/`                        | `scripts/hosted-rallar/actions/`                       |
| `scripts/distributed-validation-risk`            | `scripts/hosted-rallar/distributed-validation-risk`    |

Workflow `scp` lines copy `scripts/hosted-rallar/controller/.`. Workflow `node`
lines call `scripts/hosted-rallar/actions/` and
`scripts/hosted-rallar/distributed-validation-risk.mjs`. The test files assert
those same strings, so update the assertion and the workflow together.

- [ ] **Step 2: Keep the legacy scanner's operational prefix on the Actions scripts**

In `scripts/legacy-review/scan-changed-production.mjs`, change:

```text
normalized.startsWith('scripts/github-actions/')
```

to:

```text
normalized.startsWith('scripts/hosted-rallar/actions/')
```

Leave the `scripts/deploy/` prefix unchanged.

- [ ] **Step 3: Update the operator skill and doc with the same prefixes**

`rallar-hetzner-ops` treats `scripts/hetzner/controller/*.sh` as the VM source
of truth. After this slice that source is
`scripts/hosted-rallar/controller/*.sh`. The dispatch examples in the skill
reference and in `docs/rallar-hetzner-distributed-recipes.md` use
`scripts/hosted-rallar/dispatch-distributed-recipe.sh`.

- [ ] **Step 4: Run the focused tests**

```bash
npx vitest run \
  packages/tests/hetzner \
  packages/tests/repo/distributed-validation-risk \
  packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts \
  packages/tests/repo/legacy-review.test.ts
npm run test:repo-governance
```

Expected: both commands pass.

- [ ] **Step 5: Commit the slice**

```bash
git add scripts/hosted-rallar .github/workflows \
  packages/tests/hetzner packages/tests/repo/distributed-validation-risk \
  packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts \
  packages/tests/repo/legacy-review.test.ts \
  scripts/legacy-review/scan-changed-production.mjs \
  .agents/skills/rallar-hetzner-ops docs/rallar-hetzner-distributed-recipes.md
git commit -m "$(cat <<'EOF'
Move hosted Rallar fleet scripts under one owner.

EOF
)"
```

Commit only the files this slice changed. Drop any path from `git add` that
this slice did not touch.

---

### Task 4: Prove the cutover

- [ ] **Step 1: Search for remaining live paths**

```bash
rg -n 'scripts/hetzner|scripts/github-actions|scripts/distributed-validation-risk' \
  --glob '!plans/**' \
  --glob '!playground/**' \
  --glob '!docs/superpowers/**'
```

Expected: no matches.

- [ ] **Step 2: Confirm the copied directory is still self-contained**

```bash
rg -n 'source |\. ' scripts/hosted-rallar/controller --glob '*.sh'
```

Expected: every sourced path is a sibling filename or an absolute VM path.
None points at `scripts/hetzner` or at `scripts/hosted-rallar/actions`.

- [ ] **Step 3: Re-run the acceptance tests from Task 3 if the search required any edit**
