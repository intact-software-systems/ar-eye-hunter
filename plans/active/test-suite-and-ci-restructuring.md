# Test Suite and CI Restructuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Repo skills: `adaptive-plan-execution`,
> `rallar-testing`, `rallar-code-writing`, `publishing-plan-progress`.

**Status:** analysis complete, written 2026-09-28 against `main` `caef8ba17`. The maintainer took
all eleven rulings on 2026-09-29 (section 8). Slices 1–4 have merged and cut the gate from about 57
minutes to about 10 (section 12 has the numbers, and what differed from this plan). Slices 5–8 stay outcome-shaped under
`adaptive-plan-execution`: each becomes concrete when it starts, from the evidence in sections 2–5.

**Goal:** Cut the Branch Release Gate and the main deploy from about 55 minutes to about 18 minutes
(Slice 2), then about 10 minutes (Slice 3). Remove the duplicated, obsolete and badly written test
groups that make the suite slow and expensive to change, without losing any protected behaviour.

**Architecture:** Three changes to the gate:

1. Let superseded runs cancel.
2. Split the reusable `release-gate.yml` job into parallel lanes that each run one existing npm
   script. The required `Branch Release Gate result` check does not change.
3. Guard the split with one parsed-YAML contract test that proves the lanes cover everything
   `npm run test:ci` covers.

After that, the suite work goes by measured cost: the tests that dominate runtime first, then
tests no lane runs, then duplication, then rewrites and removals. Removals need maintainer
rulings.

**Tech Stack:** GitHub Actions (reusable workflow, composite actions), Vitest 4.1 `projects`,
Playwright 1.61, Deno 2.9 `deno test`, the API-v1 black-box runner
(`packages/shared-test/black-box-runner`).

**Spec:** Sections 1–5 of this document are the analysis. Section 1 has the measured baseline;
the other sections are the findings, each with the evidence behind it.

**Decisions already taken (maintainer, 2026-09-28):**

- Two slices concrete, the rest outcome-shaped.
- Every lane always runs, in parallel, with no path-gating.
- The plan is delivered as a draft PR.

## Global Constraints

- **Required check.** `Branch Release Gate result` stays the only required status check
  (ruleset 15939552). `scripts/validation-evidence/branch-release-result.mjs` keeps reading one
  aggregated `needs.release-gate.result`. No ruleset change.
- **`npm run test:ci` keeps working locally**, unchanged in content
  (`test:unit && test:deno && test:e2e && test:full-stack:memory`). CLAUDE.md and plan
  completion rules depend on it. CI may stop calling it only when a contract test proves the
  lanes cover it.
- **No weakening.** Never weaken any of these to make a lane pass:
  - a black-box profile or recipe
  - the medium-scale, formation or topology-replay gates
  - an assertion or a timeout budget
  - the Postgres ordering: `test:postgres:presence-expiry` runs last among the Postgres suites
    and runs twice
- **No path-gating** (maintainer decision). `paths-ignore:` stays forbidden in both gate
  workflows; `rallar-skill-plugin-publication-integrity.test.ts` pins this.
- **Deno cache.** Only a push that validates its exact `main` commit may save the Deno cache.
  Every other caller restores only.
- **GitHub Free.** The account has 20 concurrent hosted jobs. Runner minutes are free because the
  repository is public. Every lane added costs a concurrency slot, not money.
- **Test design.** Tests follow `.agents/skills/rallar-testing/SKILL.md` "Semantic Test Design
  Gate". A workflow contract is asserted on parsed YAML (`js-yaml`), never on substrings of the
  file.
- **Touched-file closure.** Touching a test file with unclassified coupling candidates fails
  `check-test-structure-coupling.mjs --changed`. Remove the coupling rather than registering it;
  a registry entry is a maintainer decision.
- **Per-slice validation**, before every push:
  - the focused tests named by the slice
  - `npm run typecheck`
  - `node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD`
  - `node scripts/check-changed-repo-style.mjs origin/main HEAD`
  - `npx dprint check <touched files>` (never a glob)
  - `npm run test:repo-governance` when `.agents/**`, `AGENTS.md`, `CLAUDE.md` or `docs/**` change
- **Delivery.** Each slice is one PR from a non-default branch. PRs land through maintainer
  review: no `pr:delivery -- ready` and no auto-merge unless the maintainer asks. Push every
  commit.

---

## 1. Measured baseline

All numbers come from real GitHub Actions runs between 2026-09-24 and 2026-09-28 unless marked
otherwise.

### 1.1 Trend

Successful `Deploy Web + API` runs, weekly wall-clock:

| Week     | Typical duration |
| -------- | ---------------- |
| 2026-W27 | 7 min            |
| 2026-W29 | 8–18 min         |
| 2026-W31 | 24–48 min        |
| 2026-W34 | 32–72 min        |
| 2026-W36 | 38–53 min        |
| 2026-W39 | 43–55 min        |

Test files tracked on `main`:

| Date       | Vitest files | Deno test files | Playwright specs | Black-box JSON |
| ---------- | ------------ | --------------- | ---------------- | -------------- |
| 2026-06-01 | 152          | 13              | 16               | 34             |
| 2026-07-01 | 285          | 29              | 30               | 45             |
| 2026-08-01 | 584          | 65              | 63               | 61             |
| 2026-09-01 | 1,028        | 136             | 63               | 89             |
| 2026-09-28 | 1,348        | 157             | 67               | 122            |

In total there are 1,603 test files with 489k lines and about 10.7k cases. Production source is
about 501k lines.

### 1.2 The `Release Gate` job

Median step durations over the last 11 successful main deploys:

| Step                                                     | Median (s) | Share |
| -------------------------------------------------------- | ---------- | ----- |
| Run root CI suite (`npm run test:ci`)                    | 1,997      | 64 %  |
| Run API v1 black-box recipes                             | 831        | 27 %  |
| Report IDE navigation details                            | 73         |       |
| Check changed repository style (PR only; 205–265 s)      | —          |       |
| Check changed test structure coupling (PR only; 19–24 s) | —          |       |
| Run Postgres full-stack smoke tests                      | 34         |       |
| Run deterministic topology replay proof                  | 32         |       |
| Run Postgres shared-server integration tests             | 29         |       |
| Install Playwright Chromium                              | 27         |       |
| Type-check TypeScript 7 workspaces                       | 26         |       |
| Check Deno apps                                          | 23         |       |
| Run Postgres presence-expiry integration tests (twice)   | 22         |       |
| Initialize containers, checkout, setup, `npm ci`, builds | ~50        |       |

The job takes about 52 minutes on main and 56–57 minutes on a PR. Over the last 45 successful
broad PR runs, push-to-verdict was p50 58, p90 63 and max 102 minutes.

Inside `npm run test:ci` (PR run 36425412819, 1,882 s):

| Part                                      | Wall (s) | Notes                                                                                                    |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `test:unit` (`vitest run`)                | 725      | 1,328 files, 12,710 tests; cumulative test time 1,669 s; import 198 s                                    |
| `test:deno`                               | 283      | api-v1 `deno test` 232 s (564 tests, no `--parallel`); control server 14 s; relic 10 s; shared-test 20 s |
| `test:rallar` (Playwright app-local)      | 207      | 98 collected, 58 self-skip; `tabbed-navigation.spec.ts` alone takes 182 s                                |
| `test:rallar:recipe-console` (Playwright) | 621      | 211 tests, 2 workers                                                                                     |
| `test:full-stack:memory` (Playwright)     | 46       | 7 tests                                                                                                  |

About the black-box recipes step (831 s):

- It runs `recipe-matrix.mts` twice: `--profile=api-v1-black-box` (59 recipes, 670 s), then
  `--profile=api-v1-black-box-cluster` (11 recipes, 151 s).
- Entries run in a plain serial `for` loop (`recipe-matrix.mts:500`). There is no shard or
  concurrency option.
- Slowest recipes:

  | Recipe                           | Time |
  | -------------------------------- | ---- |
  | `group-formation-burst-medium`   | 87 s |
  | `group-formation-burst-small`    | 84 s |
  | `state-write-convergence`        | 78 s |
  | `match-preset`                   | 52 s |
  | `activation-clock-decay`         | 50 s |
  | `group-presence-lease-lifecycle` | 40 s |

  Five formation recipes hold fixed waits totalling 128 s each.

### 1.3 Unit-suite cost distribution

Cumulative per-file time from the same run:

- The top 3 files take 687 s (41 %) and the top 25 take 1,162 s (70 %).
- 1,000 of 1,327 files take under 0.2 s each.

| Group                                                                              | Files | Cumulative |
| ---------------------------------------------------------------------------------- | ----- | ---------- |
| `packages/tests/shared-server/performance/**` (benchmark-evidence tooling)         | 11    | 755 s      |
| `packages/tests/repo/**` (governance and checker tooling)                          | 101   | 361 s      |
| — of which `repo/mutation-route-ownership/**`                                      | 21    | 201 s      |
| Other tooling (`shared-test`, `rallar-black-box`, `hetzner`, `shared-rtc-bench`)   | 418   | 192 s      |
| Product (`shared`, `shared-server` minus perf, `shared-web`, `shared-graph`, apps) | 797   | 361 s      |

78 % of unit-test time tests internal tooling, not the product. That tooling is the black-box
app, the test framework, governance scripts and the performance harness. The three slowest files
are:

- `performance/state-write/group-topology-position-balanced-pooling.test.ts`: 335 s, 7 tests,
  describe timeout 180 s.
- `performance/state-write/state-write-performance-pooling.test.ts`: 255 s, 11 tests.
- `performance/group-state/group-state-performance-policy.test.ts`: 97 s, 15 tests.

Each builds governed-scale artifacts from
`test-support/state-write-performance-artifact-fixture.ts`: 3 workloads × 9–18 runs × 700
commands, each with full receipt, outbox and AppInbox evidence. The validators under
`apps/api-v1/scripts/perf/` then deep-validate those artifacts on every call.

### 1.4 How CI fails today

Last 300 Branch Release Gate runs (2026-09-12 to 09-28): 96 success, 87 failure, 116 cancelled.

The failing step in the 87 failed runs:

| Failing step       | Runs |
| ------------------ | ---- |
| Changed repo style | 42   |
| Changed coupling   | 7    |
| Root CI suite      | 27   |
| Black-box recipes  | 10   |
| Typecheck          | 1    |

49 of 87 failed runs (56 %) stopped before any test ran, so the author learned the test verdict
one full cycle later.

Every one of those failures also shows a second, spurious failure: `Upload topology replay
artifacts` runs with `if: always()` and `if-no-files-found: error` (`release-gate.yml:176-182`).

Most frequent failing tests in the downloaded logs of those runs:

| Test                                                                        | Runs |
| --------------------------------------------------------------------------- | ---- |
| `packages/tests/rallar-black-box-headless/headless-bundle-boundary.test.ts` | 19   |
| recipe `api-v1-group-data-policy`                                           | 10   |
| `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`    | 5    |
| recipe `api-v1-drop-in-social-preset`                                       | 5    |

The non-blocking `ALM conformance observation` job failed in 14 of the 31 recent successful runs
where it ran.

### 1.5 Reproducing the numbers

`gh` must run outside the Bash sandbox (TLS verification fails inside it).

```bash
gh run list --workflow deploy.yml --status success --limit 20 --json databaseId --jq '.[].databaseId'
gh run view <run-id> --json jobs --jq '.jobs[] | select(.name=="Release Gate / Release Gate") | .steps[] | [.name, (((.completedAt|fromdateiso8601)-(.startedAt|fromdateiso8601))|tostring)] | @tsv'
gh run view <run-id> --job <job-id> --log > release-gate.log
```

Per-file Vitest durations are the `✓ <file> (<n> tests) <ms>ms` lines between `> vitest run` and
`> … test:deno` in that log. Recipe durations are the `PASSED <id>: … durationMs=<ms>` lines.

---

## 2. CI findings

### F1. Superseded PR runs are not cancelled

`branch-release-gate.yml` sets `cancel-in-progress: true` (line 15). But these three jobs use
`if: ${{ always() && … }}`:

- `release-gate` (line 106)
- `publish-validation-evidence` (line 122)
- `rtc-observation-integrity` (line 159)

GitHub's workflow-cancellation reference says: "If the condition evaluates to `true`, the job
will not get canceled. For example, the condition `if: always()` would evaluate to true and the
job continues to run." GitHub's expression reference recommends `if: ${{ !cancelled() }}`
instead.

Evidence:

- Of 116 cancelled runs, the gate job still ran to success in 45 and to failure in 26. That is
  3,132 runner-minutes for results nobody reads.
- 35 later runs waited more than 5 minutes to start, 735 minutes in total, because the concurrency
  group holds the next run until the "cancelled" one finishes.
- Example: run 36412541828 was superseded at 11:17 and ran to 11:59; the next push started at
  12:00.

`branch-release-result` must keep `always()`. A skipped required job reports success, so the
result job has to run on cancellation to fail closed.

### F2. One serial job gives one serial verdict

The only required check is `Branch Release Gate result` (ruleset 15939552). It reads the
aggregated `needs.release-gate.result`
(`scripts/validation-evidence/branch-release-result.mjs:71`). A reusable workflow's aggregate is
`failure` if any of its jobs fails; `continue-on-error` jobs such as the ALM observation are
excluded. Splitting `release-gate.yml` into parallel jobs therefore changes neither the ruleset
nor the conclusion script.

### F3. Duplicate CI work

1. **Topology replay proof runs twice.** It runs in `release-gate.yml:165-174` on every PR and
   main push. `api-v1-topology-replay-gate.yml` runs the same profile again on PRs that match its
   paths.
2. **No concurrency groups on the API-v1 gates.** The three path-filtered gates
   (`api-v1-{medium-scale,formation,topology-replay}-gate.yml`, 9, 8 and 1 min) have none, so
   every superseded push keeps running them.
3. **Repeated checks.** `deno check` of `relic-hunter-server-v1` runs twice per gate (inside
   `test:deno` and in "Check Deno apps"). `tsc` runs 16 times per gate: 12 in `typecheck`, 3 in
   the app builds, 1 in the recipe-console build.
4. **Build-only deploy jobs.** The three `deploy.yml` "Build … for Cloudflare" jobs only build;
   Cloudflare builds from git itself. They repeat the gate's "Build deployable apps" step.

### F4. Tests pin the gate workflows as text

17 Vitest files name `release-gate.yml` or `branch-release-gate.yml`; 10 of them read and assert
on it. Any restructuring must change them in the same PR. Section 6.2 lists the exact assertions
Slice 2 breaks. The worst is `packages/tests/hetzner/deploy-release-gate.test.ts:41-59`: 15
substring assertions, including `toContain('npm run test:ci')` and "exactly two
`npm run test:postgres:presence-expiry`".

### F5. Runner prerequisites of the unit suite

The Vitest suite needs:

- the `deno` binary: 31 files spawn it
- a launchable Playwright Chromium: `rallar-black-box/headless-worker-script.test.ts:108`
- `git`: 23 files, mostly temp repositories
- `npx playwright test --list`: `distributed-artifact-semantic-coverage-discovery.test.ts:47`

Every lane that runs Vitest must install what its files need.

### F6. Documentation is stale about CI

- `CLAUDE.md:278` says Branch CI "runs on every non-main push". It runs on `pull_request` only.
- `CLAUDE.md:279` lists `test:ci` as one gate step.

Slice 2 corrects both.

---

## 3. Duplicated test groups

Ranked by lines and CI time affected. The evidence is summarised here; Slice 6 turns each group
into work.

| #  | Group                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Files / lines     |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| D1 | Unrolled formation recipes (`packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-formation-{burst-small,burst-medium,burst-large,managed-burst-medium,managed-burst-large}.json`) | Step-name sets are identical after digit normalisation. `managed-burst-large` has 1,303 steps but 30 step shapes. The runner schema already supports `loop` (`schema.ts:58-59`). `churn-large` and `state-medium-scale-churn` are unrolled too (22k lines).                                                                                                                                                                                                                                                                                 | 5 (+2) / 35k JSON |
| D2 | api-v1 Deno tests that re-test shared-server code                                                                                                                                             | 6 files import no `apps/api-v1/src`: `services/group-state-service.test.ts` (1,689 lines), `services/client-state-service.test.ts` (566), `remove-dynamics-service.test.ts` (367, registers **0** `Deno.test`), `services/rate-limit-service.test.ts`, `db/managed-pglite-lifecycle.test.ts`, `db/pglite-sql-adapter-date-parameters.test.ts`. Mirrored scenarios exist in `ws-topic-room-authorizer`, `app-inbox-ws-close-convergence` and `runtime-state-read-batch` (77 % normalised line overlap). There are two PGlite harness stacks. | 7–10 / ~3,850     |
| D3 | QueueBox adapter twins (`packages/tests/shared/{in-memory,indexeddb,psql}-queuebox.test.ts`)                                                                                                  | 55 % line overlap between memory and IndexedDB. Identical titles, e.g. "returns the existing entry from enqueueIfAbsent without overwriting it" at `in-memory-queuebox.test.ts:56` and `indexeddb-queuebox.test.ts:83`. A contract-suite helper already exists unexported (`persistence-provider.test.ts:35`, `runSharedTests`).                                                                                                                                                                                                            | 6 / ~3,100        |
| D4 | Local copies of fixtures that already exist shared                                                                                                                                            | `createGroupSnapshot` ×28 (a shared `create-test-group.ts` exists), `createAuditStamp` ×16 (5 identical to `authoritative-group-fixtures.ts:7`), `jsonResponse` ×21, `runGit` ×16, `postgresIt` ×22, `requireDatabaseUrl` ×13, `expectAll` ×9 (byte-identical), `installEmptyLocalStorage` ×7 (byte-identical)                                                                                                                                                                                                                              | ~50 / ~1,000      |
| D5 | shared-web room workflow twins (`packages/tests/shared-web/rooms/room-*-workflows.test.ts`)                                                                                                   | 5 files test the same 3 modules with parallel titles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 5 / 1,925         |
| D6 | Workflow-YAML tests                                                                                                                                                                           | 26 files. `readWorkflow` is re-implemented in 7 files and `WorkflowDocument` declared in 5. `release-gate.yml` is asserted by 12 files.                                                                                                                                                                                                                                                                                                                                                                                                     | 26 / ~8,800       |
| D7 | Guidance and evaluation text tests                                                                                                                                                            | 16 files, about 440 phrase pins; the reason-code documentation check exists twice                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 16 / ~4,000       |
| D8 | Recipe Console logic in two layers                                                                                                                                                            | 84 Vitest files (1,004 tests) plus 31 Playwright specs (207 tests, 17k lines). 4 same-basename pairs re-check windowing and model logic.                                                                                                                                                                                                                                                                                                                                                                                                    | 8 / ~3,750        |
| D9 | Public-surface checks written four ways                                                                                                                                                       | `shared-web-public-api-snapshots` (836 hand-maintained lines), `shared-web-browser-entrypoints`, `shared-server-public-surface`, `rallar-server-ai-public-surface`, `rallar-bb-test-fleet-public-surface`                                                                                                                                                                                                                                                                                                                                   | 6 / ~2,100        |

These are **not duplicates** and must stay:

- adapter contract suites that assert the same behaviour against different storage
- the black-box recipes vs the unit tests of the same feature, because they observe different
  boundaries
- the 11 topology-planning test files that share the word "plan"

---

## 4. Obsolete and low-value groups

### 4.1 Tests no CI lane runs

| Tests                                                                                                                                                                                              | Why they never run                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/relic-hunters-v1/tests/*.test.ts` (20 files, 107 cases)                                                                                                                                      | Root `vitest.config.ts` includes only `packages/tests`, `packages/shared-rtc-bench/tests` and `tests/unit`. Only the workspace `npm test` runs them, and nothing calls it. |
| `tests/playwright/rallar-black-box/exhaustive-*.spec.ts` (9 specs, 27 tests)                                                                                                                       | `playwright.exhaustive.config.ts` has no CI caller.                                                                                                                        |
| Env-gated full-stack specs: director, distributed-recipes (2,008 lines), live-rtc ×2 (RTC-B06 only), auth-multi-session, browser-rallar-resilience, manual-rallar-realtime, recipe-console-monitor | They need flags or a Postgres API that CI never provides. In `test:rallar` they are collected and skipped (58 of 98).                                                      |
| `tests/playwright/relic-hunters` (3 specs), `tests/playwright/ar-eye-hunter` (2 specs)                                                                                                             | Manual scripts only, or none at all.                                                                                                                                       |
| `packages/tests/shared-server/rallar-system/topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts`                                                                                  | Postgres-gated, but missing from the `include` of `vitest.postgres-integration.config.mjs`.                                                                                |
| `packages/tests/shared-server/integration/postgres/test-support/*.test.ts` (2 files)                                                                                                               | The integration glob is not recursive.                                                                                                                                     |
| `scripts/hosted-rallar/controller/authenticated-ws-smoke.test.ts` (4 Deno tests)                                                                                                                   | No task runs it.                                                                                                                                                           |
| `apps/api-v1/test/remove-dynamics-service.test.ts`                                                                                                                                                 | Registers 0 `Deno.test`; runs only under `import.meta.main`.                                                                                                               |
| 13 pixel baselines (`*-chromium-darwin.png`)                                                                                                                                                       | The specs skip unless `process.platform === 'darwin'`, and CI is Linux.                                                                                                    |

### 4.2 Dead configuration and vacuous guards

- `deno.json` tasks `test:queue`, `qbox`, `async` and `engine` point at
  `packages/tests/{queue,ComputeAsynctask,engine}.test.ts`, which do not exist.
- The npm script `test:repo-governance` names two deleted files,
  `auth-server-compatibility-{governance,runtime-identity}.test.ts`.
  `test:shared-black-box:companion` names the deleted `shared-web/rallar-data.test.ts`.
- `packages/tests/repo/auth-server-module-reference-validation.ts` (205 lines) has no references.
- `packages/shared-rtc-bench/tests/architecture/rtc-benchmark-package-boundaries.test.ts:124` scans
  `scripts/perf`. That directory moved in #587, so the test always passes.
- `packages/tests/shared/queuedeno.test.ts` (1 case) names a subject that exists nowhere else and
  overlaps `queue.test.ts`.

### 4.3 Guards on retired or historical things

- **Tombstones.** 12 repository test files assert that a retired thing stays absent: `deno fmt`,
  `plan:adapt`, `package-code-style.md`, Deno `tsconfig.json`, `skills/`, root
  `playwright.config.ts`, `apps/web` and `FleetPreview.tsx`.
- **Historical pins:**
  - `maintenance-stewardship-contract.test.ts:381-387` pins SHA-256 of the v1 evaluation JSON.
  - `general-agent-guidance-evidence.test.ts` pins a frozen evaluation campaign.
  - `tests-typecheck-gate.test.ts:62` checks the shape of a typecheck-debt ledger that is now 0/0.
  - `group-topology-position-balanced-pooling.test.ts` hard-codes `HISTORICAL_PR_A_BASE_COMMIT`
    and similar constants.
- **`packages/tests/repo/governance-decisions/**`** (15 files, about 94 cases). Current commands
  reject plan operations, gate deviations and exception decisions (`scripts/governance-decisions/README.md:84`).
  Yet two files still import `scripts/plan-adaptation/**` to build `plan-adaptation-v1` fixtures.
  What stays live: `deploy.yml` runs `npm run test:governance-decisions` and
  `governance:decide -- verify-commit` for historical receipt replay.
- **Export-existence tests.** They only assert `typeof x === 'function'`:
  `shared-web/rooms/room-membership.test.ts:9` (7 checks), `room-target.test.ts:3`,
  `update-room.test.ts`, `create-and-join-room.test.ts`, `join-room.test.ts` and
  `room-presence.test.ts`. Behavioural tests in the same files already import those functions.
- **Constant-equals-literal pins.** 8 cases, e.g. `apps/relic-hunters-v1/tests/motion-tuning.test.ts:32`
  (9 pins) and `recipe-console-history-model.test.ts:323`. The latter pins a `@deprecated`
  constant that has no other consumer.

---

## 5. Badly written tests

| #   | Pattern                                                 | Evidence                                                                                                                                                                                                                                                                                                                                          | Scale         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| B1  | Text assertions on YAML, shell, docs, skills and source | 1,746 assertions in 80 files: `repo` 905, `hetzner` 479, `rallar-black-box` 197. `hetzner/distributed-recipe-workflow.test.ts` has 3,543 lines, 301 pins and 33 commits of churn. PR #590 (the docs rewrite) had to edit 4 of these tests. The coupling checker cannot see YAML, docs or skills text, nor source paths built with `new URL(...)`. | 80 files      |
| B2  | Bundle-budget ratchets in test bodies                   | `headless-bundle-boundary.test.ts:82` holds a KiB literal behind a 25-line prose history. It changed in 25 commits since 2026-08-15 and failed 19 PR runs. `shared-web-browser-bundle-boundaries.test.ts` changed in 20 commits and failed 5 runs.                                                                                                | 2 files       |
| B3  | Mock call-count and order assertions                    | The full-tree coupling run finds 558 candidates; 183 are unreviewed, all `mock-invocation-count-or-order` (top: `use-rallar-arena-auth-lifecycle` 24, `relic-hunters-runtime` 21, `recipe-console-control-query` 15). The registry holds 375 entries.                                                                                             | 40+ files     |
| B4  | Recipe expectations the runner never compares           | `preflight/strict-expectation-debt.json` lists 46 in 11 recipes (`api-v1-openapi-topology-auth` 20) and calls each "a weakened assertion to be repaired".                                                                                                                                                                                         | 11 recipes    |
| B5  | Real wall-clock waits in unit tests                     | 109 unit files; 20 mix fake timers with real waits. A real 10 s lease sleep sits at `integration/postgres/al-outbound-effect-claims.test.ts:55`. 12 Playwright `waitForTimeout` calls, 5.5 s at most.                                                                                                                                             | 109 files     |
| B6  | Tests of test data                                      | `api-v1-medium-scale-recipe.test.ts:21` has 90 expects in one case pinning recipe JSON values. `recipe-matrix.test.ts:318` pins sorted id lists that mirror `recipe-matrix.json`, so every recipe PR edits it (18 commits since 2026-08-15).                                                                                                      | ~10 files     |
| B7  | Giant files and cases                                   | 66 test files over 1,000 lines. 66 unit cases over 150 lines; the largest are 647 (`group-state-inbox-operation-matrix.test.ts:117`), 567 and 493.                                                                                                                                                                                                | 66 files      |
| B8  | Static analysers living inside the test tree            | `packages/tests/repo/mutation-route-ownership/**` holds 12.4k lines of analyser, 4.1k lines of tests and 208 cases, taking 201 s in CI. The analyser re-reads production source per case.                                                                                                                                                         | 21 test files |
| B9  | Heavily mocked shared-web runtime tests                 | 11 files mock 6–11 of their subject's internal sibling modules (e.g. `browser-director-relay-runtime` 11, `rallar-calls` 10)                                                                                                                                                                                                                      | 11 files      |
| B10 | In-suite bundling, spawning and typechecking            | `recipe-console-build-boundary.test.ts` runs `vite build`. Two esbuild bundle tests. Three rtc-bench diagnostics spawn `deno check`. `recipe-matrix.test.ts` spawns `deno` per recipe.                                                                                                                                                            | ~8 files      |

---

## 6. Slice 1 — CI quick wins (concrete)

**Outcome:**

- A superseded PR run stops within a minute.
- The next push's run starts immediately.
- An early failure shows one red step, not two.
- The duplicated topology-replay run disappears (ruling R1).
- The main deploy stops rebuilding the three web apps that the gate already built (ruling R11).

**Expected saving:**

- Up to 57 minutes of queueing on every superseded push.
- About 3,000 runner-minutes and about 700 queue-minutes per 300 runs, measured.
- 1 minute of a job slot per matching PR.

**Files:**

- Modify: `.github/workflows/branch-release-gate.yml` (lines 106, 122, 159)
- Modify: `.github/workflows/release-gate.yml` (lines 165–182)
- Modify: `.github/workflows/api-v1-medium-scale-gate.yml`, `api-v1-formation-gate.yml`
- Delete: `.github/workflows/api-v1-topology-replay-gate.yml` (ruling R1)
- Modify: `.github/workflows/deploy.yml`, removing `deploy-eye-hunter`, `deploy-relic-web` and
  `deploy-rallar-kit` (ruling R11)
- Test: `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`
- Test: `packages/tests/repo/api-v1-black-box-workflow.test.ts`
- Test: `packages/tests/hetzner/deploy-release-gate.test.ts`

### Task 1.1: Cancellable Branch Release Gate jobs

- [ ] **Step 1: Write the failing test.** Add it to
      `packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`, next to "validates
      the PR source against its event base…". The file already has `readWorkflow` (parsed YAML).

```ts
it('lets a superseded run cancel every job except the fail-closed result', () => {
    const workflow = readWorkflow('.github/workflows/branch-release-gate.yml');

    for (
        const jobId of ['release-gate', 'publish-validation-evidence', 'rtc-observation-integrity']
    ) {
        const condition = workflow.jobs[jobId].if as string;
        expect(condition.startsWith('${{ !cancelled() && ')).toBe(true);
        expect(condition).not.toContain('always()');
    }
    // A skipped required job reports success, so the result job must run on cancellation too.
    expect(workflow.jobs['branch-release-result'].if).toBe('${{ always() }}');
});
```

- [ ] **Step 2: Run it and confirm it fails.**
      `npx vitest run packages/tests/repo/pull-request-delivery/pull-request-workflow.test.ts`.
      Expected: FAIL on `release-gate` (the condition starts with `${{ always() &&`).
- [ ] **Step 3: Change the three conditions.** In each, replace `always() &&` with
      `!cancelled() &&` and keep the rest of the expression unchanged:

```yaml
if: ${{ !cancelled() && needs.governance-gate.result == 'success' && needs.validation-evidence.outputs.mode == 'broad' }}
# publish-validation-evidence
if: ${{ !cancelled() && needs.release-gate.result == 'success' && needs.validation-evidence.outputs.mode == 'broad' }}
# rtc-observation-integrity
if: ${{ !cancelled() && needs.governance-gate.result == 'success' && needs.validation-evidence.outputs.mode == 'rtc-observation' }}
```

`!cancelled()` is a status-check function, so it removes the implicit `success()` exactly as
`always()` did. Behaviour differs only when the run is cancelled.

- [ ] **Step 4: Rerun the test and the other pins on this file.** Expected: PASS.

```bash
npx vitest run packages/tests/repo/pull-request-delivery packages/tests/repo/validation-evidence packages/tests/repo/governance-gate packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts packages/tests/repo/repository-governance.test.ts
```

`validation-evidence-workflow.test.ts` asserts that `release.if` contains
`outputs.mode == 'broad'`, which still holds.

- [ ] **Step 5: Commit.** "Let superseded Branch Release Gate runs cancel".

### Task 1.2: Concurrency groups on the path-filtered API-v1 gates

- [ ] **Step 1: Write the failing test.** Add it to
      `packages/tests/repo/api-v1-black-box-workflow.test.ts`. It reads the three files with
      `readYaml`; add `concurrency` to that file's `WorkflowDocument` interface.

```ts
it.each([
    '.github/workflows/api-v1-medium-scale-gate.yml',
    '.github/workflows/api-v1-formation-gate.yml'
])('cancels a superseded %s run of the same pull request', async (workflowPath) => {
    const workflow = await readYaml<WorkflowDocument>(workflowPath);

    expect(workflow.concurrency).toEqual({
        group: '${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
        'cancel-in-progress': '${{ github.event_name == \'pull_request\' }}'
    });
});
```

There is no topology-replay row, because Task 1.3 deletes that workflow (ruling R1).

- [ ] **Step 2: Run it and confirm it fails** (`concurrency` is undefined).
- [ ] **Step 3: Add the block** after `permissions:` in each workflow. Manual
      `workflow_dispatch` runs queue instead of cancelling one another.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- [ ] **Step 4: Rerun it.** `npx vitest run packages/tests/repo/api-v1-black-box-workflow.test.ts`.
      Expected: PASS.
- [ ] **Step 5: Commit.** "Cancel superseded API-v1 gate runs".

### Task 1.3: One red step per failure, and one topology-replay run

- [ ] **Step 1: Give the replay step an id** in `release-gate.yml`: `id: topology_replay` on
      "Run deterministic topology replay proof".
- [ ] **Step 2: Condition the upload on that step.** "Upload topology replay artifacts" changes
      from `if: always()` to:

```yaml
if: ${{ !cancelled() && steps.topology_replay.outcome != 'skipped' }}
```

It still errors when the proof ran and left no files, so the `if-no-files-found: error`
contract is kept.

- [ ] **Step 3: Retire the duplicate workflow (ruling R1).**
  - Move "Record exact checkout SHA" (`validated-sha.txt`, `validated-tree.txt`) from
    `api-v1-topology-replay-gate.yml` into the Release Gate, just before the replay step, so the
    files land in its artifact directory.
  - Upload the same files the retired workflow uploaded: the two records,
    `rtc-topology-replay-proof.json`, `rtc-topology-replay-proof-failure.json` and the four
    server logs. The artifact name stays `api-v1-topology-replay-${{ github.sha }}`.
  - Delete `api-v1-topology-replay-gate.yml`.
  - In `api-v1-black-box-workflow.test.ts`, retarget "publishes an exact-SHA topology replay gate
    with the proof and all four logs" (line 138) to the Release Gate job, and remove the workflow
    from the `workflowJobs` table (line 59).
  - Rephrase `CLAUDE.md` and `.agents/skills/rallar-testing/SKILL.md` wherever they name the
    dedicated topology-replay gate. The npm script `test:api-v1:black-box:postgres:topology-replay`
    stays for local runs.
- [ ] **Step 4: Run the focused tests.**

```bash
npx vitest run packages/tests/repo/api-v1-black-box-workflow.test.ts packages/tests/hetzner/deploy-release-gate.test.ts packages/tests/repo/github-actions-runtime-governance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the per-slice validation** (Global Constraints), then commit: "Report one
      failure per early gate failure".

### Task 1.4: Stop rebuilding the web apps in the main deploy (ruling R11)

- [ ] **Step 1: Delete the three build-only jobs** `deploy-eye-hunter`, `deploy-relic-web` and
      `deploy-rallar-kit` from `deploy.yml` (lines 194–270). Cloudflare builds `main` from git
      itself (`docs/production-deployment.md`), and the Release Gate's "Build deployable apps"
      step builds the same three workspaces.
- [ ] **Step 2: Update `deploy-release-gate.test.ts`.**
  - Remove the `deployJobs` loop (lines 61–71) and the `deployAfterReleaseGateCondition` constant
    it alone uses.
  - Add a parsed-YAML check that no `deploy.yml` job runs `npm run build` outside the reusable
    Release Gate.
  - Keep the Deno deploy assertions unchanged.
- [ ] **Step 3: Run the focused tests.** Expected: PASS.

```bash
npx vitest run packages/tests/hetzner/deploy-release-gate.test.ts packages/tests/repo/governance-decisions/governance-decision-workflow.test.ts
```

- [ ] **Step 4: Commit.** "Stop rebuilding the web apps after the Release Gate".

**Acceptance (first CI runs on the PR):**

- Push a second commit while the first run is in its root CI suite step. The first run's
  `Release Gate / Release Gate` job must end as `cancelled` within about a minute, and the second
  run's governance job must start at once.
- On a run with a deliberately failing changed-style step (a throwaway commit, reverted), exactly
  one step is red.
- `Branch Release Gate result` is still reported on every run.

**Rollback:** revert the PR. Only workflow files and tests change.

**Risk:** a manual cancel of the latest run now leaves `Branch Release Gate result` red instead of
running the gate to completion. This is intended: the result is fail-closed.

---

## 7. Slice 2 — Parallel lanes (concrete)

**Outcome:**

- `release-gate.yml` runs eight parallel jobs instead of one serial job. The PR gate and the main
  deploy both call it, so both get the lanes.
- `Branch Release Gate result` and `deploy.yml` keep their `needs: release-gate` contract.
- Every suite `npm run test:ci` runs is proven, by a parsed-YAML contract test, to run in exactly
  the lanes.
- Expected push-to-verdict drops from about 58 to about 18 minutes; the black-box lane is the
  critical path. Main deploy drops from about 54 to about 19 minutes.

### 7.1 Lane design

| Job id                        | Display name                   | Runs                                                                                                                                                                                   | Needs                                     | Est. wall                  |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------- |
| `checks`                      | Static checks                  | navigation report; changed range, changed style, changed coupling (PR only); `npm run typecheck`; 3 app builds; Deno checks                                                            | Deno                                      | ~7.5 min PR, ~3.5 min main |
| `unit-tooling`                | Unit tests (tooling)           | `npm run test:unit:tooling` = Vitest project `tooling` (`shared-server/performance/**`, `repo/**`, `hetzner/**`: 120 files, 1,128 s cumulative, floor 335 s)                           | Deno                                      | ~8 min                     |
| `unit`                        | Unit tests                     | `npm run test:unit:main` = Vitest project `unit` (the other 1,208 files, 541 s cumulative)                                                                                             | Deno, Chromium                            | ~6 min                     |
| `deno`                        | Deno tests                     | `npm run test:deno`                                                                                                                                                                    | Deno (saves the cache on exact-main push) | ~6 min                     |
| `e2e-app`                     | Browser tests (app)            | `npm run test:rallar`, then `npm run test:full-stack:memory`                                                                                                                           | Deno, Chromium                            | ~5.5 min                   |
| `e2e-recipe-console`          | Browser tests (Recipe Console) | `npm run test:rallar:recipe-console`                                                                                                                                                   | Chromium                                  | ~12 min                    |
| `black-box`                   | API black-box recipes          | composite `api-v1-black-box-test` (unchanged inputs) plus upload                                                                                                                       | Deno, Postgres service                    | ~15.5 min                  |
| `postgres-integration`        | Postgres integration           | `npm run db:migrate` → `test:postgres:integration` → topology replay proof plus upload → `test:rallar:full-stack:postgres:rest` and `:control` → `test:postgres:presence-expiry` twice | Deno, Chromium, Postgres service          | ~5 min                     |
| `alm-conformance-observation` | ALM conformance observation    | unchanged                                                                                                                                                                              | —                                         | unchanged                  |

**Why eight lanes, not five and not twelve.** GitHub Free allows 20 concurrent jobs account-wide.
A mutation-path PR push already starts:

| Source                                            | Jobs |
| ------------------------------------------------- | ---- |
| Governance                                        | 1    |
| ALM observation                                   | 1    |
| Path-filtered API-v1 gates (R1 retired the third) | 2    |
| CodeQL                                            | 2    |

With eight lanes, one push peaks at about 13 concurrent jobs, and two simultaneous pushes queue a
few jobs briefly. Five coarse lanes would leave the gate at about 25 minutes (unit + deno + e2e in
one lane). More lanes would not shorten the critical path, because the 831 s black-box lane
dominates until Slice 3 shards it.

The Vitest split follows the measured cost, not the directory tree. A plain `--shard` hashes file
paths and can put the 335 s and 255 s files in the same shard.

Why each lane has the prerequisites it does:

- Every lane keeps `fetch-depth: 0` and the current checkout `ref` expression in Slice 2. Nothing
  about repository history changes.
- `RALLAR_API_CONFIGURATION_PROFILE: prod-in-memory` moves to workflow-level `env`.
- `DATABASE_URL` goes on the two Postgres lanes only. Today `test:ci` runs with `DATABASE_URL`
  set but no `RALLAR_POSTGRES_INTEGRATION`, and every Postgres-dependent unit test is gated on that
  flag. The first-run count comparison (section 7.4) proves nothing changed.
- `postgres-integration` keeps the documented order: integration suite, then presence-expiry last
  and twice. Its Postgres container is private to the lane, so no other lane can observe its
  fixed-ID outbox rows.

### 7.2 Tests that change with the split

| File                                                                                                                                   | Current assertion                                                                        | Replacement                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tests/hetzner/deploy-release-gate.test.ts:41-59`                                                                             | 15 substring pins on `release-gate.yml`, including `toContain('npm run test:ci')`        | Delete these pins; the new lane contract test (Task 2.3) owns them. Keep the `deploy.yml` job-ordering assertions (lines 61–85).                                                                                          |
| `packages/tests/repo/api-v1-black-box-workflow.test.ts:60`                                                                             | `['.github/workflows/release-gate.yml', ['release-gate']]`, reading job-level `env`      | `['black-box', 'postgres-integration']`, reading the effective env `{ ...workflow.env, ...job.env }`                                                                                                                      |
| `packages/tests/repo/github-actions-runtime-governance.test.ts:61-80`                                                                  | `indexOf` ordering of `run: npm ci` < navigation < changed style in the file text        | Assert the step order on the parsed `checks` job: setup action, then navigation, then range, then changed style                                                                                                           |
| `packages/tests/repo/github-actions-runtime-governance.test.ts:82-106`                                                                 | Named cache steps and their `if` found by text in `release-gate.yml`                     | Assert on `.github/actions/release-gate-setup/action.yml`: restore-only unless `save-deno-cache == 'true'`. In `release-gate.yml`, exactly one job passes the exact-main expression and every other job passes `'false'`. |
| `packages/tests/repo/governance-decisions/governance-decision-workflow.test.ts:243-251`                                                | `releaseGate.jobs['release-gate'].steps` holds the two changed-range steps without `env` | `releaseGate.jobs.checks.steps`                                                                                                                                                                                           |
| `typescript-7-boundaries.test.ts:183-195`, `tests-typecheck-gate.test.ts:53-59`, `repo-code-style-authority-integrity.test.ts:169-189` | Substrings that still appear verbatim in the `checks` job                                | No change required. Record in the PR that they are satisfied, and fold them into the contract test in Slice 7.                                                                                                            |

### Task 2.1: Vitest projects that keep `test:unit` whole

**Files:** modify `vitest.config.ts` and `package.json` (scripts `test:unit:tooling`,
`test:unit:main`).

- [ ] **Step 1: Record the baseline file list.**

```bash
npx vitest list --filesOnly > "$TMPDIR/vitest-before.txt"
wc -l < "$TMPDIR/vitest-before.txt"
```

Expected: 1,328 files (1,327 plus the one skipped-only file).

- [ ] **Step 2: Move `include` and `exclude` into two projects.** Keep aliases, environment,
      globals and setup at the root.

```ts
const SUITE_TESTS = [
    'packages/tests/**/*.test.ts',
    'packages/shared-rtc-bench/tests/**/*.test.ts',
    'tests/unit/**/*.test.ts'
];
const EXCLUDED_TESTS = [
    'packages/tests/shared-server/integration/**',
    'packages/tests/shared-test/scenario-black-box-rtc-config.test.ts',
    'packages/tests/shared-test/rtc-client-provider/**'
];
// Benchmark-evidence and repository tooling: 120 files, two thirds of the unit suite's time.
const TOOLING_TESTS = [
    'packages/tests/shared-server/performance/**/*.test.ts',
    'packages/tests/repo/**/*.test.ts',
    'packages/tests/hetzner/**/*.test.ts'
];

export default defineConfig({
    root: __dirname,
    resolve: { alias: {/* unchanged */} },
    test: {
        environment: 'node',
        globals: true,
        setupFiles: ['packages/tests/setup-vitest.ts'],
        projects: [
            {
                extends: true,
                test: { name: 'tooling', include: TOOLING_TESTS, exclude: EXCLUDED_TESTS }
            },
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: SUITE_TESTS,
                    exclude: [...EXCLUDED_TESTS, ...TOOLING_TESTS]
                }
            }
        ]
    }
});
```

- [ ] **Step 3: Prove the partition is exact.** The two project lists must be disjoint, and their
      union must equal the baseline.

```bash
npx vitest list --filesOnly --project tooling > "$TMPDIR/vitest-tooling.txt"
npx vitest list --filesOnly --project unit > "$TMPDIR/vitest-unit.txt"
sort "$TMPDIR/vitest-tooling.txt" "$TMPDIR/vitest-unit.txt" | uniq -d | wc -l
sort -u "$TMPDIR/vitest-tooling.txt" "$TMPDIR/vitest-unit.txt" | diff - <(sort "$TMPDIR/vitest-before.txt")
```

Expected: `0`, then an empty diff. If `extends: true` concatenated the root arrays, the diff
shows it; root-level `include` must not exist.

- [ ] **Step 4: Add the scripts.** `"test:unit:tooling": "vitest run --project tooling"` and
      `"test:unit:main": "vitest run --project unit"`. `test:unit` stays `vitest run`, which runs all
      projects.
- [ ] **Step 5: Run `npm run test:unit`** and check that its summary line matches the baseline
      counts. Read the summary line, not the exit code.
- [ ] **Step 6: Commit.** "Split the Vitest suite into tooling and unit projects".

### Task 2.2: Lane setup composite action

**Files:** create `.github/actions/release-gate-setup/action.yml`.

- [ ] **Step 1: Write the action.** Checkout stays in each job, because a local action can only
      run after checkout.

```yaml
name: Release gate lane setup
description: Install Node dependencies and the optional Deno and Playwright toolchains one Release Gate lane needs.
inputs:
  deno:
    description: Install Deno and restore its cache.
    required: false
    default: 'false'
  playwright:
    description: Install Playwright Chromium and its system dependencies.
    required: false
    default: 'false'
  save-deno-cache:
    description: Save the Deno cache after the job. Only the push that validates its exact main commit passes true.
    required: false
    default: 'false'
runs:
  using: composite
  steps:
    - name: Setup Node
      uses: actions/setup-node@v7
      with:
        node-version: 24
        cache: npm
        cache-dependency-path: package-lock.json
    - name: Setup Deno
      if: ${{ inputs.deno == 'true' }}
      uses: denoland/setup-deno@v2
      with:
        deno-version: v2.x
    - name: Restore Deno cache without save permission
      if: ${{ inputs.deno == 'true' && inputs.save-deno-cache != 'true' }}
      uses: actions/cache/restore@v6
      with:
        path: |
          ~/.cache/deno
          ~/.deno
        key: ${{ runner.os }}-deno-${{ hashFiles('deno.lock', 'apps/**/deno.lock') }}
        restore-keys: |
          ${{ runner.os }}-deno-
    - name: Cache Deno for trusted runs
      if: ${{ inputs.deno == 'true' && inputs.save-deno-cache == 'true' }}
      uses: actions/cache@v6
      with:
        path: |
          ~/.cache/deno
          ~/.deno
        key: ${{ runner.os }}-deno-${{ hashFiles('deno.lock', 'apps/**/deno.lock') }}
        restore-keys: |
          ${{ runner.os }}-deno-
    - name: Install dependencies
      shell: bash
      run: npm ci
    - name: Install Playwright Chromium
      if: ${{ inputs.playwright == 'true' }}
      shell: bash
      run: npx playwright install --with-deps chromium
```

- [ ] **Step 2: Check it.** `npx dprint check .github/actions/release-gate-setup/action.yml`, then
      `npx vitest run packages/tests/repo/github-actions-runtime-governance.test.ts`. The "Node 24
      action releases" test scans `.github/actions` too and must still pass.
- [ ] **Step 3: Commit** together with Task 2.3; the action is unused until then.

### Task 2.3: Lanes and the lane contract test

**Files:**

- Modify: `.github/workflows/release-gate.yml`
- Create: `packages/tests/repo/release-gate-lanes.test.ts`
- Modify: the tests in section 7.2

- [ ] **Step 1: Write the failing contract test,** `packages/tests/repo/release-gate-lanes.test.ts`.
      It reads parsed YAML, `package.json` and the Vitest config, so it protects the behaviour "CI runs
      everything the documented local gate runs" and nothing about file text.

```ts
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import vitestConfig from '../../../vitest.config.ts';

interface WorkflowStep {
    readonly run?: string;
    readonly uses?: string;
    readonly with?: Readonly<Record<string, string>>;
}
interface WorkflowJob {
    readonly 'continue-on-error'?: boolean;
    readonly services?: Readonly<Record<string, unknown>>;
    readonly steps: readonly WorkflowStep[];
}
interface WorkflowDocument {
    readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const repoRoot = path.resolve(__dirname, '../../..');
const scripts = (JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
}).scripts;
const releaseGate = load(
    readFileSync(path.join(repoRoot, '.github/workflows/release-gate.yml'), 'utf8')
) as WorkflowDocument;
const blockingJobs = Object.entries(releaseGate.jobs).filter(([, job]) =>
    job['continue-on-error'] !== true
);

describe('Release Gate lanes', () => {
    it('runs every suite npm run test:ci composes', () => {
        const invoked = new Set(
            blockingJobs.flatMap(([, job]) => job.steps.flatMap(toNpmScripts)).flatMap(toLeaves)
        );
        const required = toLeaves('test:ci').filter((leaf) => leaf !== 'test:unit');

        expect(required.filter((leaf) => !invoked.has(leaf))).toEqual([]);
    });

    it('runs every Vitest project in exactly one lane', () => {
        const projectNames = (vitestConfig.test?.projects ?? []).map((project) => project.test.name)
            .sort();
        const laneProjects = blockingJobs
            .flatMap(([, job]) => job.steps.flatMap(toNpmScripts))
            .flatMap((name) =>
                [...scripts[name].matchAll(/--project[= ](\S+)/gu)].map((match) => match[1])
            )
            .sort();

        expect(laneProjects).toEqual(projectNames);
    });

    it('keeps Postgres presence expiry last and twice inside one Postgres lane', () => {
        const [, lane] = blockingJobs.find(([, job]) =>
            job.steps.some((step) => step.run?.includes('test:postgres:presence-expiry'))
        )!;
        const commands = lane.steps.flatMap(toNpmScripts);

        expect(lane.services).toHaveProperty('postgres');
        expect(commands.slice(-2)).toEqual([
            'test:postgres:presence-expiry',
            'test:postgres:presence-expiry'
        ]);
        expect(commands.indexOf('test:postgres:integration')).toBeGreaterThan(-1);
    });
});

function toNpmScripts(step: WorkflowStep): string[] {
    return [...(step.run ?? '').matchAll(/npm run ([\w:-]+)/gu)].map((match) => match[1]);
}

// A script that only chains `npm run` calls expands to its members; anything else is a leaf.
function toLeaves(name: string): string[] {
    const members = [...scripts[name].matchAll(/npm run ([\w:-]+)/gu)].map((match) => match[1]);
    const onlyChains =
        scripts[name].replace(/npm run [\w:-]+/gu, '').replace(/&&/gu, '').trim() === '';
    return onlyChains && members.length > 0 ? members.flatMap(toLeaves) : [name];
}
```

The contract test does **not** include `test:unit` directly. Its coverage is the second test:
every configured project must be run by exactly one lane.

- [ ] **Step 2: Run it against the current single job.**
      `npx vitest run packages/tests/repo/release-gate-lanes.test.ts`. Expected: the first test
      PASSES, because `npm run test:ci` expands inside the one job. The second FAILS: no lane passes
      `--project`.
- [ ] **Step 3: Rewrite `release-gate.yml`.**
  - Keep the `workflow_call` inputs and `permissions`, and add workflow-level
    `env: RALLAR_API_CONFIGURATION_PROFILE: prod-in-memory`.
  - Replace the `release-gate` job with the eight jobs of section 7.1. Every job starts with the
    unchanged checkout step, then `uses: ./.github/actions/release-gate-setup` with its toolchain
    inputs. Only `deno` passes:

    ```yaml
    save-deno-cache: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && inputs.candidate_ref == github.sha }}
    ```

  - Keep step names and `run:` commands verbatim from today's job. For example, `checks` keeps
    "Report IDE navigation details", "Resolve immutable changed-review range" (`id:
    changed_review_range`), "Check changed repository style", "Check changed test structure
    coupling", "Type-check TypeScript 7 workspaces", "Build deployable apps" and "Check Deno apps"
    with their current `if:` and `run:`.
  - Timeouts: `checks` 20; `unit-tooling`, `unit`, `deno` and `e2e-app` 20; `e2e-recipe-console`
    25; `black-box` 30; `postgres-integration` 20.
  - `black-box` and `postgres-integration` each get today's `postgres:16` service block and
    `env: DATABASE_URL: postgresql://app:app@localhost:5432/appdb`.
  - `alm-conformance-observation` is unchanged, including its restore-only cache.
- [ ] **Step 4: Update the five tests in section 7.2.** In each touched test file, resolve every
      coupling candidate the changed-range checker reports for it.
- [ ] **Step 5: Run the workflow and repository tests.** Expected: all PASS.

```bash
npx vitest run packages/tests/repo packages/tests/hetzner packages/tests/playwright
node scripts/check-test-structure-coupling.mjs --changed origin/main HEAD
npx dprint check .github/workflows/release-gate.yml .github/actions/release-gate-setup/action.yml packages/tests/repo/release-gate-lanes.test.ts
```

- [ ] **Step 6: Commit and push.** "Run the Release Gate as parallel lanes".

### Task 2.4: Documentation of the gate

- [ ] **Step 1: Correct `CLAUDE.md` lines 278–286.**
  - Branch CI runs on `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`,
    `labeled`, `unlabeled`).
  - `release-gate.yml` runs parallel lanes; name them.
  - `npm run test:ci` remains the local equivalent of the four test lanes.
- [ ] **Step 2: Update `.agents/skills/rallar-testing/references/test-commands.md:211`.** "Release
      Gate follows this same order" becomes "The Release Gate's Postgres integration lane follows this
      same order".
- [ ] **Step 3: Run the governance suite.** `npm run test:repo-governance`, then
      `npx dprint check CLAUDE.md .agents/skills/rallar-testing/references/test-commands.md`.
      Expected: PASS.
- [ ] **Step 4: Commit.** "Describe the parallel Release Gate lanes".

### 7.4 Acceptance for Slice 2 (first green CI run on the PR)

The new run must execute the same tests as a pre-split baseline run on the same code. Compare the
lane summary lines with PR run 36425412819, updated for any tests added since:

| Lane                    | Must show                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `unit` + `unit-tooling` | Test Files 1,324 passed + 4 skipped; Tests 12,698 passed + 12 skipped                                 |
| `deno`                  | `ok \| 564 passed`, `ok \| 188 passed`, `ok \| 5 passed (12 steps)`, `ok \| 146 passed`               |
| `e2e-app`               | `40 passed`, `58 skipped`, then `7 passed`                                                            |
| `e2e-recipe-console`    | `199 passed`, `12 skipped`                                                                            |
| `black-box`             | `Matrix profile api-v1-black-box: passed=59` and `Matrix profile api-v1-black-box-cluster: passed=11` |
| `postgres-integration`  | Integration `21 passed` files; presence-expiry `10 passed` twice; replay proof artifact present       |

Wall-clock targets:

- `Release Gate` wall-clock (first lane start to last lane end) is 20 minutes or less.
- `Branch Release Gate result` concludes success.
- On the first main push after merge, the deploy workflow reaches the Deno deploy jobs within
  about 20 minutes, and exactly one job saved the Deno cache.

If any count differs, stop and classify it (`adaptive-plan-execution` "Failure classification")
before changing anything.

**Rollback:** revert the PR. `release-gate.yml`, the composite action, `vitest.config.ts` and the
test changes revert together.

**Risks, ranked:**

1. **A lane silently runs less than before.** Mitigated by the contract test and the count
   comparison in 7.4.
2. **Concurrency queueing** under the 20-job limit when several PRs push at once. Measure queue
   time for a week. If p90 wait exceeds 5 minutes, merge `deno` into `e2e-app` and `checks` into
   `unit-tooling` (6 lanes).
3. **A missing lane prerequisite** (for example, a Vitest file in the tooling project that needs
   Chromium). This fails loudly, not silently; add the toolchain to that lane.
4. **Vitest `projects` merge semantics.** Guarded by Task 2.1 Step 3.

---

## 8. Maintainer rulings (taken 2026-09-29)

The maintainer took the recommended answer on every ruling. Each entry names the slice that
carries it out.

- **R1. Retire `api-v1-topology-replay-gate.yml`: yes.** The Release Gate runs the identical proof
  on every PR and main push. Move the exact-SHA records and the four server logs into the gate's
  replay upload, then delete the workflow. Slice 1, Task 1.3.
- **R2. The formation-burst recipes stay in the required gate.** `burst-small` (84 s) and
  `burst-medium` (87 s) both stay until Slice 3 splits the recipes across jobs. Revisit them then,
  with measurements.
- **R3. `apps/relic-hunters-v1/tests` join the root Vitest `unit` project** once they pass there,
  including the 21 unreviewed mock call-count candidates in `relic-hunters-runtime.test.ts`.
  Slice 4.
- **R4. `packages/tests/repo/governance-decisions/**` keeps only live paths.**
  - Keep: the tests of what `deploy.yml` still runs (receipt replay and `verify-commit`, push
    classification, admission verification).
  - Delete: the tests of retired plan and exception operations, together with the
    `scripts/plan-adaptation/**` imports that only they keep alive.
  - Superseded on `main` by `7f61e51b3` ("Doc updates and obsolete governance."). That commit
    removed the whole governance-decision mechanism: the suite, its scripts,
    `governance-decision.yml` and the governance jobs in `deploy.yml`. Nothing is left for
    Slice 8 to do here.
- **R5. Agent-guidance prose pins become one routing contract.** Every `SKILL.md` has valid
  frontmatter, every file it references exists, and `.codex-plugin/plugin.json` lists every skill.
  The fresh-agent evaluations carry behaviour, as `AGENTS.md:25-29` already says. Slice 8.
- **R6. Tombstones: delete the ones that guard deleted files and scripts.** Keep checker-level bans
  that encode a live rule, such as `skipLibCheck` or no `fmt` block while dprint owns formatting.
  Slice 8.
- **R7. Darwin-only pixel baselines get Linux baselines.** Generate them once with
  `--update-snapshots` in a dedicated PR, so the `e2e-recipe-console` lane gates them in CI. Keep
  the darwin baselines for local runs. After Slice 2.
- **R8. The exhaustive Playwright specs run weekly.** They get a scheduled workflow with a Postgres
  service and a named owner. A failure opens an issue and never blocks a PR. Slice 4.
- **R9. Bundle budgets move into one committed `bundle-budgets.json`.** Both bundle tests read it,
  and each run prints the measured figures to the job summary. The 2026-09-05 rule stays: raise
  the ceiling to the next whole KiB and record the measured figure in the same commit. Slice 7.
- **R10. The performance-evidence tooling tests keep one governed-scale case per validator.** Every
  other case runs on a minimum-valid artifact, after confirming which validator rules need
  governed scale. Target: under 60 s. Slice 5.
- **R11. Remove the three `deploy.yml` build-only Cloudflare jobs.** The Release Gate already builds
  the same three apps. Slice 1, Task 1.4.

---

## 9. Slices 3–8 (outcome-shaped)

Each slice becomes concrete, with exact tasks, when it starts. The acceptance criteria and safety
rules below are binding.

### Slice 3 — Shorten the critical path (target: gate 10 minutes or less)

**Delivered in #615 and #617.** See section 12 for what changed against this outline.

**Work:**

- **Split the black-box lane.** Add a standard-only mode to `api-v1-black-box-run.mts`. Today a
  tertiary port always appends the cluster profile (`api-v1-black-box-run.mts:272-282`). With
  the new mode, one lane runs `api-v1-black-box` on the unchanged three-server topology and
  another runs `--cluster-only`.
- **Shard the black-box profile.** Add `--shard=<i>/<n>` to `recipe-matrix.mts`. Assign entries by
  longest-processing-time over committed durations, with a fallback to a stable hash, and shard
  the 670 s standard profile two ways.
- **Shard the Recipe Console specs.** `npm run test:rallar:recipe-console -- --shard=1/2` and
  `--shard=2/2`.
- **Run api-v1 Deno tests in parallel.** `deno test --parallel` (232 s, about 1 s of PGlite
  per test).
- **Cache Playwright browsers** keyed on the Playwright version.

**Safety rules:**

- **Recipe order independence.** Before a sharded lane is trusted, run each shard both in listed
  order and with `--shuffle` (a flag added in the same PR) three times against a fresh database.
  Run the full profile unsharded once, with the same result. Reason: recipes share one
  `{runId}` per profile run, and past failures came from identity collisions and the
  registration rate limit.
- **Fairness proof.** It must still find its fixture. `verifyApiV1FairnessProof` reads both
  matrix summaries in the lane's artifact directory.
- **Deno parallelism.** Accept `deno test --parallel` only after 5 consecutive green runs locally
  and 5 in CI with no new flake.

**Acceptance:**

- Critical-path lane is 9 minutes or less.
- Recipe counts across shards sum to 59 + 11.
- Peak concurrent jobs per push stays at 16 or less; otherwise merge small lanes.

### Slice 4 — Every test file runs somewhere (section 4.1)

**Split in two, both merged.** 4a (#619) removed the references and guards that ran nothing. 4b
(#620) ran the tests no lane ran and added the reachability check. Section 12 records what each
found, including the three suites that stayed manual because they fail when run.

**Work:**

- Add a script, `scripts/check-test-reachability.mjs`. It lists every tracked `*.test.ts`,
  `*.spec.ts` and `Deno.test` file and resolves each against the runner configs that
  `release-gate.yml` invokes: the Vitest projects, Deno test roots, Playwright configs with
  `testMatch`, and the Postgres include list.
- Files that no runner reaches must appear in `tests/manual-suites.json` with an owner, a command
  and a reason. The script runs in the `checks` lane. It is a script, not a text pin.
- Fix the dark items in section 4.1 per rulings R3 and R8:
  - Include `postgres-topology-app-inbox-concurrency.test.ts` (verify it passes on Postgres first).
  - Make the integration glob recursive.
  - Convert or delete `remove-dynamics-service.test.ts`.
  - Wire `authenticated-ws-smoke.test.ts` into a manual suite.
- Fix section 4.2: stale `deno.json` tasks, stale npm script paths, the orphan helper, the
  vacuous `scripts/perf` guard (point it at `apps/api-v1/scripts/perf` or delete it) and
  `queuedeno.test.ts`.

**Acceptance:**

- The reachability script reports 0 unowned files.
- Every newly wired suite passes in its lane.

### Slice 5 — Runtime dominators (target: unit lanes 4 minutes or less)

**Work:**

- Performance-evidence fixture diet (ruling R10): 755 s → under 60 s.
- `mutation-route-ownership`: parse the real source once per worker, not per case (201 s).
- `recipe-matrix.test.ts`: validate all recipes in one `deno` process instead of one per recipe
  (36 s).
- `repo-style-*` git-fixture tests: shared fixture repositories (about 110 s).
- `al-inbound-queue-work.test.ts` (38 s) and `queuebox-work-page.test.ts` (16 s): fake timers
  instead of real waits.

**Safety rule:** before and after each change, a mutation probe proves the case still fails: break
the validator rule the case targets and confirm it goes red. Record the probe in the PR.

**Acceptance:**

- The top file is under 30 s.
- Tooling-lane cumulative time is under 300 s.
- No case count decreases without a mapped replacement.

### Slice 6 — Consolidate duplicates (section 3)

**Order:**

1. D3 QueueBox contract suite (promote `runSharedTests`).
2. D4 shared fixtures: `createGroupSnapshot`, `createAuditStamp`, `postgresIt` and
   `requireDatabaseUrl` into one Postgres gate module, `runGit`, `expectAll`.
3. D2 api-v1 Deno re-tests: move or delete, and unify the PGlite harness.
4. D5 room workflow twins.
5. D1 formation recipes: re-express with `loop`, keeping every step's assertions.
6. D8 Recipe Console layer overlap: keep the model logic in Vitest and the user flows in
   Playwright.

**Safety rule:** each merge or delete PR carries a table mapping every removed test title to the
surviving test that protects the same behaviour. For recipes, `recipe-matrix` validation output
and step counts must match before and after.

**Acceptance:**

- Lines removed are reported.
- No behaviour appears in the mapping without a surviving test.

### Slice 7 — Rewrites (section 5)

**Work:**

- **B1.** Replace workflow and shell text pins with parsed-YAML contracts on one shared
  `readWorkflow` helper, starting with `hetzner/distributed-recipe-workflow.test.ts` (301 pins).
  Production-source text tests become behaviour tests at the owned boundary, or, where the
  subject is a boundary rule, analyzer-based checks with a registry entry the maintainer approves.
- **B2.** Bundle budgets (ruling R9).
- **B3.** Rewrite the 183 unreviewed call-count assertions as observable effect logs (the idiom in
  `packages/tests/shared-web/connection/browser-transport-cleanup.test.ts`), file by file.
- **B4.** Repair the 46 uncompared recipe expectations until `strict-expectation-debt.json` is
  empty, then delete it.
- **B5.** Fake timers for unit tests with real waits.
- **B6.** Replace pinned recipe-id lists with a rule-based check: every recipe is in a profile,
  and every profile is non-empty.
- **B7.** Split files over 1,500 lines and cases over 150 lines as they are touched.

**Acceptance:**

- Each rewritten file has zero unreviewed coupling candidates.
- Text-assertion count drops by at least 50 % from 1,746.

### Slice 8 — Obsolete and low-value removals (section 4.3)

**Work:** apply rulings R4, R5 and R6. Delete the export-existence and constant-literal pins
whose behaviour is covered elsewhere in the same file.

**Safety rule:** for each deletion, the evidence is either that the subject no longer exists or
that the covering test is named in the PR body.

**Acceptance:** `npm run test:repo-governance` and `npm run test:unit` are green, and the deleted
lines are reported.

---

## 10. Standing rules that keep the suite from regressing

1. **Reachability.** Every test file is reachable from a CI lane or listed as a manual suite with
   an owner. Enforced by `scripts/check-test-reachability.mjs` in the `checks` lane (Slice 4).
2. **Duration report.**
   - Both Vitest lanes write `--reporter=json`. A small script prints the 20 slowest files to
     `$GITHUB_STEP_SUMMARY`.
   - A file over 30 s is a warning.
   - A file over 60 s blocks unless it appears in a committed allowlist, which is expected to be
     empty after Slice 5.
3. **Lane budget.** A lane over 12 minutes for five consecutive main runs gets split, sharded or
   diet-reviewed. The lane table in section 7.1 is the reference.
4. **Where tooling tests live.** Tests of repository tooling, CI and benchmark evidence go into
   the `tooling` Vitest project's directories, not the product directories.
5. **Workflow contracts.** Workflow and action behaviour is asserted on parsed YAML through one
   shared helper. New substring pins on workflow files are rejected in review.

## 11. Risks across the programme, ranked by impact

1. **A lane split drops coverage without anyone noticing.** Mitigation: the Slice 2 contract test,
   the count comparison, and Slice 4 reachability.
2. **Removals hide a real regression.** Mitigation: rulings for guard removals, mapping tables and
   mutation probes.
3. **Concurrency limits erase the wall-clock gain.** Mitigation: Slice 1 cancellation first,
   measured queue times, and lane-merge fallbacks.
4. **Sharded recipes expose order dependence as flakes.** Mitigation: the shuffle proof before
   trust, and unsharded fallback via one input.
5. **Touching coupled test files trips the changed-range gate and grows scope.** Mitigation: plan
   each slice's touched files up front, and keep new tests in new files only where the repo rules
   allow it.

## 12. What shipped, and what it measured

All figures are from real runs on 2026-09-29. "Gate" means the blocking lanes; "verdict" means the
`Branch Release Gate result` check.

| PR   | Merged as   | What it did                                                                                                                                                                                                         | Measured                                                                                                              |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| #613 | `91a09eec3` | `!cancelled()` on three gate jobs, concurrency on the API-v1 gates, the topology replay proof runs once, three build-only Cloudflare deploy jobs removed                                                            | No Cloudflare build jobs on the next `main` deploy                                                                    |
| #614 | `61f9783a7` | Eight parallel lanes, a shared setup action, Vitest projects `tooling` and `unit`, the lane contract test                                                                                                           | Gate 14.6 min (was 52–57); `main` deploy 16.6 min (was about 55); every suite's counts identical to the serial run    |
| #615 | `82697e470` | Black-box lane as three runners, Recipe Console as two Playwright shards, runner flags `--shard` and `--standard-only`                                                                                              | Blocking lanes about 9.3 min; 60 + 11 recipes and 199 + 12 specs, identical to before                                 |
| #617 | `0d5902bc6` | The ALM observation moves into its own reusable workflow that both callers start beside the gates                                                                                                                   | Verdict 9.7 min after the run was created, with ALM still running                                                     |
| #619 | `c87d941fe` | The remove-dynamics scenarios that never ran, stale task and script references, a task-reference test, the vacuous RTC guard                                                                                        | See its description; `main` gate green                                                                                |
| #616 | `94f1f3d84` | The group-admission limiter keeps its keys unique past 160 characters (a separate task the plan spawned)                                                                                                            | The black-box run-id constraint below no longer needs a margin                                                        |
| #620 | `3978a908d` | `check-test-reachability` in the `checks` lane and `tests/manual-suites.json`; the Relic Hunters app tests, the AppInbox concurrency test and the `test-support` tests now run; the ws-smoke test joins `test:deno` | 1,629 test files, 1,624 run by CI, 5 manual, 0 unowned; `main` gate 12 min after the lanes started, all deploys green |

Push to verdict fell from a median of 58 minutes to about 10, and the verdict now arrives in one
cycle instead of stopping at the first failing serial step.

### Differences from the outline above

- **Slice 5 was not executed, by ruling.** Its performance-evidence fixture diet (R10) assumed the
  validators accept a smaller artifact. They do not: `STATE_WRITE_COMMANDS_PER_RUN = 700` and
  `measuredRuns !== 9` (18 for the group-state policy) are constants in the production validators, so
  every case needs a governed-scale artifact. A CPU profile of one pooling call (9.5 s for four
  sources) shows no hotspot: `structuredClone` 1.8 s, and the rest spread across the durable-evidence
  and outbox validators. The three files cost about 450 s of the tooling project's 853 s locally, and
  in CI the `unit` lane's Vitest wall is 325 s and the `unit-tooling` lane's is 412 s. What remains
  would be sharding both lanes and splitting the three heavy files (verdict about 7 to 5 minutes), or
  parameterising the validators. The maintainer chose to move on to Slice 6 on 2026-09-29.

- **Slice 4 ended with three suites left manual, not wired.** Trying to run them showed why they were
  dark. The Relic Hunters Playwright suite fails on a camera-mode assertion locally (24 passed, 1
  failed, 1 skipped). The AR Eye Hunter Playwright suite passes locally but three specs time out on the
  Linux runner waiting for canvas effects, which turned the first #620 gate red. Both are in
  `tests/manual-suites.json` with the failure recorded, and the Relic Hunters full-stack spec needs a
  game-server stack no lane starts. The Postgres integration files must also run serially, on a
  database of their own: a parallel Node run of the same config failed six tests.

- **Slice 3 split the black-box lane differently.** The runner's `--standard-only` and `--cluster-only`
  flags plus `--shard=<index>/<count>` gave three runners: two balanced shares of the standard
  profile, and the cluster profile beside them. Every lane keeps all three API servers, because the
  two formation-burst recipes use the secondary and tertiary ones. The shard resolver and its weights
  live in `packages/shared-test/black-box-runner/recipe-matrix/`.
- **`deno test --parallel` was not done.** Deno stopped being on the critical path, and the change
  needs repeated green runs first.
- **The ALM observation was not in the outline.** It is non-blocking, but the reusable Release Gate
  workflow only completes when all its jobs do, so the verdict and every deployment waited for it:
  12.5 min on a passing run and 21 min on a failing one, after the blocking lanes had finished in
  about 9. #617 fixed it.

### What the work taught

- A job whose `if` is still true is never cancelled, so `always()` on the gate jobs kept superseded
  runs alive. `!cancelled()` is the fix, and only the result job keeps `always()`.
- A `vitest run <path>` argument is a filter. A deleted test file silently leaves a script, which is how
  two scripts lost tests unnoticed. `task-file-references.test.ts` now guards this.
- **The black-box run id must stay identical in every lane.** Recipes build their app, workspace and
  group ids from it, and the group-admission limiter cuts its keys at 160 characters. Adding a lane id
  made one recipe's principal key 188 characters, which merged every principal of a group into one
  limiter and produced an HTTP 429. With the original run id the same key is 155 characters, so the
  margin is 5. The limiter now keeps its keys unique (#616), but the run id is still pinned by a contract test.
- Two pull requests merged back to back make the first `main` deploy fail its stale-main guard. That is
  the guard working, not a regression.
- A test moved out of the place its runner looks can go dark without anyone noticing. The
  remove-dynamics scenarios registered no Deno test for as long as they existed. When they finally
  ran, one was broken and its assertion could never fail.
