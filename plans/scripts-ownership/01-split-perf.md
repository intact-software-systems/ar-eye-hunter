# Split `scripts/perf` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the three owners inside `scripts/perf/` their own directories and
delete `scripts/perf/` in the same change.

**Architecture:** `git mv` each group with its internal layout intact. API-v1
state-write, CRDT compare, snapshot read, and group-topology pooling move to
`apps/api-v1/scripts/perf/`, including `state-write/` and
`map-with-concurrency.ts`. The recipe-console scale bench moves to
`apps/rallar-black-box/scripts/`. Shared-server runtime, fanout, and SQL seed
benches move to `scripts/platform/perf/`. Live callers are retargeted in this
slice. `scripts/deploy/` and `scripts/transaction-write-check/` stay put.

**Tech Stack:** Git, Node, Deno via `apps/api-v1/deno.json`, Vitest, dprint.

## Global Constraints

- Hard cutover. Update every live caller and delete the old path. Leave no
  wrapper at `scripts/perf/`.
- Leave historical text unchanged under `plans/` (except this directory, which
  stays as the review spec), `playground/`, and `docs/superpowers/plans/`.
- Preserve relative imports inside a moved group.
- Replace the import segment `scripts/perf/` with the destination path. Keep
  the existing `../` count in test imports.
- `map-with-concurrency.ts` moves with the API-v1 suite. It has three callers,
  all in that suite.
- Commands run from the repository root.
- Do not weaken performance thresholds, artifact schemas, or benchmark
  constants while moving files.

---

### Task 1: Move the API-v1 harness

**Files:**

- Move every file below from `scripts/perf/` to `apps/api-v1/scripts/perf/`,
  keeping `state-write/` as a subdirectory:

```text
api-v1-state-snapshot-read-bench.ts
api-v1-state-write-artifact-validation.mjs
api-v1-state-write-attempt-evidence.ts
api-v1-state-write-concurrency-bench.ts
api-v1-state-write-durable-evidence.ts
api-v1-state-write-group-receipt-evidence.ts
api-v1-state-write-outbox-contract.mjs
api-v1-state-write-outbox-evidence.ts
api-v1-state-write-outbox-expectations.ts
api-v1-state-write-outbox-repository.ts
api-v1-state-write-outbox-resource-codec.ts
api-v1-state-write-receipt-evidence.ts
api-v1-state-write-result-binding.mjs
capture-api-v1-state-write-environment.mjs
compare-api-v1-crdt-append-history-results.mjs
compare-api-v1-state-write-results.mjs
compare-group-state-server-structure-performance.mjs
create-instrumented-state-write-sql.ts
create-state-write-benchmark-sql.ts
create-state-write-service-runtime.ts
map-with-concurrency.ts
pool-api-v1-state-write-results.mjs
pool-group-topology-state-write-position-balanced-results.mjs
read-state-write-postgres-counters.ts
state-write-wait-options.ts
validate-api-v1-state-write-environment.mjs
validate-state-write-attempt-evidence.mjs
validate-state-write-durable-evidence.mjs
validate-state-write-pooling-source.mjs
write-api-v1-state-write-pooled-results.mjs
write-group-topology-state-write-position-balanced-results.mjs
state-write/api-v1-state-write-app-inbox-evidence.ts
state-write/api-v1-state-write-benchmark-artifact.ts
state-write/api-v1-state-write-benchmark-options.ts
state-write/api-v1-state-write-regression-reasons.ts
```

- Modify these three imports from
  `../../apps/api-v1/src/db/api-v1-database-lifecycle.ts` to
  `../../src/db/api-v1-database-lifecycle.ts`:
  - `apps/api-v1/scripts/perf/create-state-write-service-runtime.ts`
  - `apps/api-v1/scripts/perf/api-v1-state-write-durable-evidence.ts`
  - `apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts`

- [ ] **Step 1: Move the files**

```bash
mkdir -p apps/api-v1/scripts/perf
git mv scripts/perf/state-write apps/api-v1/scripts/perf/state-write
git mv scripts/perf/api-v1-state-snapshot-read-bench.ts \
  scripts/perf/api-v1-state-write-artifact-validation.mjs \
  scripts/perf/api-v1-state-write-attempt-evidence.ts \
  scripts/perf/api-v1-state-write-concurrency-bench.ts \
  scripts/perf/api-v1-state-write-durable-evidence.ts \
  scripts/perf/api-v1-state-write-group-receipt-evidence.ts \
  scripts/perf/api-v1-state-write-outbox-contract.mjs \
  scripts/perf/api-v1-state-write-outbox-evidence.ts \
  scripts/perf/api-v1-state-write-outbox-expectations.ts \
  scripts/perf/api-v1-state-write-outbox-repository.ts \
  scripts/perf/api-v1-state-write-outbox-resource-codec.ts \
  scripts/perf/api-v1-state-write-receipt-evidence.ts \
  scripts/perf/api-v1-state-write-result-binding.mjs \
  scripts/perf/capture-api-v1-state-write-environment.mjs \
  scripts/perf/compare-api-v1-crdt-append-history-results.mjs \
  scripts/perf/compare-api-v1-state-write-results.mjs \
  scripts/perf/compare-group-state-server-structure-performance.mjs \
  scripts/perf/create-instrumented-state-write-sql.ts \
  scripts/perf/create-state-write-benchmark-sql.ts \
  scripts/perf/create-state-write-service-runtime.ts \
  scripts/perf/map-with-concurrency.ts \
  scripts/perf/pool-api-v1-state-write-results.mjs \
  scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs \
  scripts/perf/read-state-write-postgres-counters.ts \
  scripts/perf/state-write-wait-options.ts \
  scripts/perf/validate-api-v1-state-write-environment.mjs \
  scripts/perf/validate-state-write-attempt-evidence.mjs \
  scripts/perf/validate-state-write-durable-evidence.mjs \
  scripts/perf/validate-state-write-pooling-source.mjs \
  scripts/perf/write-api-v1-state-write-pooled-results.mjs \
  scripts/perf/write-group-topology-state-write-position-balanced-results.mjs \
  apps/api-v1/scripts/perf/
```

- [ ] **Step 2: Point the three database-lifecycle imports at the app source**

In each of the three files listed above, replace:

```ts
from '../../apps/api-v1/src/db/api-v1-database-lifecycle.ts'
```

with:

```ts
from '../../src/db/api-v1-database-lifecycle.ts'
```

- [ ] **Step 3: Confirm intra-suite imports still resolve**

`state-write/api-v1-state-write-benchmark-artifact.ts` imports
`../compare-api-v1-state-write-results.mjs`. That relative path stays valid
because both files moved together. Do not rewrite imports that stay inside
`apps/api-v1/scripts/perf/`.

---

### Task 2: Retarget API-v1 callers

**Files:**

- Modify the Vitest importers below. Replace the import path segment
  `scripts/perf/` with `apps/api-v1/scripts/perf/`. Files under `test-support/`
  use one more `../` than their parents; replacing only the `scripts/perf/`
  segment keeps that count correct.
  - `packages/tests/shared-server/performance/state-write/state-write-performance-topology-reasons.test.ts`
  - `packages/tests/shared-server/performance/state-write/group-topology-position-balanced-pooling.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-performance-harness.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-snapshot-outbox-evidence.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-malformed-evidence.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-performance-wait-budget.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-performance-result-binding.test.ts`
  - `packages/tests/shared-server/performance/state-write/state-write-performance-pooling.test.ts`
  - `packages/tests/shared-server/performance/state-write/test-support/state-write-performance-result-fixture.ts`
  - `packages/tests/shared-server/performance/state-write/test-support/state-write-performance-artifact-fixture.ts`
  - `packages/tests/shared-server/performance/group-state/group-state-performance-policy.test.ts`
  - `packages/tests/shared-server/integration/postgres/state-write-benchmark-sql.test.ts`
  - `packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts`
- Modify `scripts/repo-style-check/reviewed-dispositions.mjs`. These reviewed
  keys must follow the files or the style checker stops applying them. Replace
  the `scripts/perf/` prefix with `apps/api-v1/scripts/perf/` on exactly these
  paths:
  - `scripts/perf/api-v1-state-write-result-binding.mjs`
  - `scripts/perf/api-v1-state-write-group-receipt-evidence.ts`
  - `scripts/perf/api-v1-state-write-artifact-validation.mjs`
  - `scripts/perf/compare-api-v1-state-write-results.mjs`
  - `scripts/perf/validate-state-write-attempt-evidence.mjs`
  - `scripts/perf/validate-state-write-durable-evidence.mjs`
  - `scripts/perf/api-v1-state-write-concurrency-bench.ts`
- Modify `package.json` scripts:

```json
"perf:api-v1:state-write": "deno run -A --config apps/api-v1/deno.json apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts",
"perf:api-v1:crdt-append-history:compare": "node apps/api-v1/scripts/perf/compare-api-v1-crdt-append-history-results.mjs",
```

- Modify `.github/workflows/api-v1-medium-scale-gate.yml`: change the path
  filter `scripts/perf/api-v1-state-snapshot-read-bench.ts` to
  `apps/api-v1/scripts/perf/api-v1-state-snapshot-read-bench.ts`.
- Modify the comment in `docker-compose.perf-bench.yml` that names
  `scripts/perf/validate-api-v1-state-write-environment.mjs` so it names
  `apps/api-v1/scripts/perf/validate-api-v1-state-write-environment.mjs`.

- [ ] **Step 1: Rewrite the import segment in every listed test**

- [ ] **Step 2: Rewrite the seven reviewed-disposition paths**

- [ ] **Step 3: Rewrite the npm scripts, workflow path filter, and compose comment**

- [ ] **Step 4: Run the API-v1 performance tests**

```bash
npx vitest run \
  packages/tests/shared-server/performance/state-write \
  packages/tests/shared-server/performance/group-state/group-state-performance-policy.test.ts \
  packages/tests/shared-server/integration/postgres/state-write-benchmark-sql.test.ts \
  packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts
```

Expected: PASS. The group-list fanout harness still imports
`scripts/perf/group-list-fanout-bench.ts` until Task 4, so leave that file out
of this command.

---

### Task 3: Move the recipe-console bench

**Files:**

- Move `scripts/perf/rallar-recipe-console-scale-bench.ts` to
  `apps/rallar-black-box/scripts/rallar-recipe-console-scale-bench.ts`.
- The current `scripts/perf/README.md` does not document this bench. Do not add
  a new README for it.

- [ ] **Step 1: Move the file**

```bash
git mv scripts/perf/rallar-recipe-console-scale-bench.ts \
  apps/rallar-black-box/scripts/rallar-recipe-console-scale-bench.ts
```

- [ ] **Step 2: Rewrite the three imports**

```ts
import { searchDistributedArtifactEvidence } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence/search-distributed-artifact-evidence.ts';
import {
    createRecipeConsoleScaleFixture,
    validateRecipeConsoleScaleFixtureSize
} from '../../../packages/shared-test/rallar-bb-test/scale-fixture.ts';
import { createAnalyzeArtifactModel } from '../src/recipe-console/analyze/analyze-artifact-model.ts';
```

- [ ] **Step 3: Typecheck the bench with the API-v1 Deno config if the app alias map does not cover it**

The bench uses relative imports, so this Deno check is enough:

```bash
deno check --config apps/api-v1/deno.json \
  apps/rallar-black-box/scripts/rallar-recipe-console-scale-bench.ts
```

Expected: the check completes without an unresolved import. If Deno cannot
resolve a relative path, fix that import. Do not add a package alias for this
move.

---

### Task 4: Move the shared-server benches and split the README

**Files:**

- Move to `scripts/platform/perf/`:
  - `runtime-validation-bench.ts`
  - `summarize-runtime-results.mjs`
  - `client-list-fanout-bench.ts`
  - `group-list-fanout-bench.ts`
  - `seed-perf-db.sql`
  - `explain-perf-db.sql`
  - `seed-perf-db-sparse-queue.sql`
- Create `scripts/platform/perf/README.md` from the shared-server parts of
  `scripts/perf/README.md`.
- Create `apps/api-v1/scripts/perf/README.md` from the API-v1 parts.
- Delete `scripts/perf/README.md` with the rest of `scripts/perf/`.
- Modify `packages/tests/shared-server/performance/group-state/group-list-fanout-performance-harness.test.ts`
  so it imports `../../../../../scripts/platform/perf/group-list-fanout-bench.ts`.
- Modify live docs:
  - `AGENTS.md` performance section
  - `.agents/skills/performance-analysis/SKILL.md`
  - `.agents/skills/performance-analysis/references/webrtc-performance-focus.md`
  - `.agents/skills/rallar-testing/SKILL.md`
  - `.agents/skills/rallar-testing/references/test-commands.md`

- [ ] **Step 1: Move the platform files**

```bash
mkdir -p scripts/platform/perf
git mv scripts/perf/runtime-validation-bench.ts \
  scripts/perf/summarize-runtime-results.mjs \
  scripts/perf/client-list-fanout-bench.ts \
  scripts/perf/group-list-fanout-bench.ts \
  scripts/perf/seed-perf-db.sql \
  scripts/perf/explain-perf-db.sql \
  scripts/perf/seed-perf-db-sparse-queue.sql \
  scripts/platform/perf/
```

- [ ] **Step 2: Split the README by section**

`scripts/platform/perf/README.md` keeps these sections, with every command path
rewritten from `scripts/perf/` to `scripts/platform/perf/`:

- opening paragraphs, Motivation, Artifact Policy
- Scripts table rows for the seven platform files
- RTC/WebRTC benchmark package
- Prerequisites, including the sentence that Deno harnesses use
  `apps/api-v1/deno.json`
- Focused Runtime Harness, CPU Profiling, GC Trace, Postgres Query Plans,
  Database Safety

`apps/api-v1/scripts/perf/README.md` keeps these sections, with every command
path rewritten from `scripts/perf/` to `apps/api-v1/scripts/perf/`:

- a short artifact-policy paragraph: run outputs belong under `tmp/perf/` and
  are not committed
- Scripts table rows for the API-v1 files
- Prerequisites: commands run from the repository root and Deno uses
  `--config apps/api-v1/deno.json`
- CRDT append-history black-box diagnostic
- API-v1 State-write Concurrency Baseline
- Pinned Benchmark Environment

Interpreting Results stays with the README whose commands it explains. When a
paragraph explains both owners, split the paragraph with the commands.

- [ ] **Step 3: Remove the empty `scripts/perf/` directory**

```bash
rmdir scripts/perf
```

Expected: the directory is gone. If `rmdir` fails, a file was left behind.
Move that file to the owner it imports, or to `scripts/platform/perf/` when it
imports only `shared-server`.

- [ ] **Step 4: Retarget the fanout test and the live docs**

In `AGENTS.md`, replace the performance-analysis bullets that cite
`scripts/perf/README.md` and `scripts/perf/**` with:

```markdown
- Read `scripts/platform/perf/README.md` before adding a shared-server benchmark.
  API-v1 state-write harnesses live under `apps/api-v1/scripts/perf/`.
```

In `.agents/skills/performance-analysis/SKILL.md` and
`.agents/skills/rallar-testing/references/test-commands.md`, change:

```bash
node scripts/perf/compare-api-v1-state-write-results.mjs
```

to:

```bash
node apps/api-v1/scripts/perf/compare-api-v1-state-write-results.mjs
```

In `.agents/skills/rallar-testing/SKILL.md`:

- Replace `` `scripts/perf/**` consumer `` with
  `` `apps/api-v1/scripts/perf/**` and `scripts/platform/perf/**` consumers ``.
- Replace the compare command path the same way as the test-commands file.

In `.agents/skills/performance-analysis/references/webrtc-performance-focus.md`,
point the README citations and the `runtime-validation-bench.ts` command at
`scripts/platform/perf/`.

- [ ] **Step 5: Commit the slice**

```bash
git add apps/api-v1/scripts/perf apps/rallar-black-box/scripts/rallar-recipe-console-scale-bench.ts \
  scripts/platform/perf scripts/repo-style-check/reviewed-dispositions.mjs \
  package.json .github/workflows/api-v1-medium-scale-gate.yml \
  docker-compose.perf-bench.yml AGENTS.md .agents/skills/performance-analysis \
  .agents/skills/rallar-testing packages/tests/shared-server/performance \
  packages/tests/shared-server/integration/postgres/state-write-benchmark-sql.test.ts \
  packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts
git commit -m "$(cat <<'EOF'
Move perf scripts to their owning app and platform homes.

EOF
)"
```

---

### Task 5: Prove the cutover

- [ ] **Step 1: Search for a remaining live `scripts/perf` path**

```bash
rg -n 'scripts/perf' \
  --glob '!plans/**' \
  --glob '!playground/**' \
  --glob '!docs/superpowers/**'
```

Expected: no matches. Matches inside this plan directory, other historical
plans, playground notes, or `docs/superpowers/plans/` are out of scope and
excluded by the globs.

- [ ] **Step 2: Run the focused tests and the skill gate**

```bash
npx vitest run \
  packages/tests/shared-server/performance \
  packages/tests/shared-server/integration/postgres/state-write-benchmark-sql.test.ts \
  packages/tests/shared-test/api-v1-crdt-append-history-recipe.test.ts
npm run test:repo-governance
```

Expected: both commands pass. `test:repo-governance` is required because
skills and `AGENTS.md` changed.

- [ ] **Step 3: Confirm Deno still resolves the moved state-write bench**

```bash
deno check --config apps/api-v1/deno.json \
  apps/api-v1/scripts/perf/api-v1-state-write-concurrency-bench.ts \
  scripts/platform/perf/runtime-validation-bench.ts \
  scripts/platform/perf/client-list-fanout-bench.ts \
  scripts/platform/perf/group-list-fanout-bench.ts
```

Expected: no unresolved imports.
