# The ALM conformance lane in CI

The ALM conformance lane is the strongest proof ALM has, and almost none of it runs in CI. This plan
puts all of it there: the smoke scope becomes a required lane of the Release Gate, the full scope runs
on the PostgreSQL API for every push to `main` and for every pull request that can change ALM, and a
ledger computed from those runs says how close each carrier is to becoming required too.

Nothing is built yet. The maintainer decided the shape on 2026-11-21 (see "Decisions").

## Why

**What CI runs today** (`main` at `d70f2f165`):

- `.github/workflows/alm-conformance-observation.yml` runs the lane
  (`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`) once per carrier (`ws`,
  `rtc`, `rtc-with-ws-fallback`), in the `smoke` scope, against the in-memory API.
- Its jobs have `continue-on-error: true` and nothing waits for them. Five pushes in a row were red
  on 2026-11-15 to 2026-11-17 and merged anyway.
- The `smoke` scope is 14 or 15 scenarios per carrier, in two of the six families. The `full` scope
  is 60 (`ws`), 69 (`rtc`) and 50 (`rtc-with-ws-fallback`) scenarios. The scenarios that prove granted
  topics, ordered entry, receipts, claims, leader acknowledgement, faults and recovery are all
  `full` only, so they run only on a developer's machine.
- A run records one outcome per family test. Which scenario failed is only in the text of a
  Playwright assertion, and a scenario that never ran after an error is recorded nowhere.

**What that costs.** A regression in a `full` scenario merges unseen. D639 names the bar for making
the lane blocking (about ten green full runs in a row per carrier with no rerun, on the PostgreSQL
API, and a flake ledger whose entries each carry a root cause), and no run today can count toward it.

## Goals

1. The `smoke` scope is a required lane: a red smoke run fails the Release Gate, on a pull request and
   on `main`.
2. The `full` scope runs in CI on the PostgreSQL API: on every push to `main`, and on a ready pull
   request unless its diff cannot change ALM.
3. Every run records the outcome of every planned scenario: passed, failed or not run.
4. One command prints, from the recent `main` runs, each carrier's streak of green full runs and
   each scenario's failures, and names every failed scenario that has no recorded root cause.
5. The full scope can be started on any branch on demand, so a flake fix can be proven by repeated
   runs before it merges.

## Non-goals

- Fixing the known flakes (`missing-recipient-retry` over `rtc`, the `subscription-ordered-reconnect`
  probe race). Each is its own slice after this plan, most frequent first, led by the ledger.
- Making a full-scope carrier required. That is a later one-line change per carrier, decided by the
  maintainer when the ledger shows the streak.
- The hosted (Hetzner) campaign and its manifests.
- Changing a lane budget, a scenario, or the scope a scenario belongs to.

## Anti-goals

- A ledger that reads green when scenarios did not run. A scenario that was planned and has no
  outcome counts against the run.
- A quarantine list. Every scenario counts toward the streak.
- Retries that hide a flake. The lane keeps Playwright's `retries` at 0.
- CI that commits or pushes. The ledger is computed on demand; its history is the run artifacts
  (GitHub keeps them 90 days).
- A second copy of anything: one lane spec, one result record, one reader of GitHub runs.

## Constraints

- The maintainer's standing rules, verbatim: "Sub-agent-driven development and TDD. No legacy to
  retain, no migration code, avoid code duplication, prefer functional style, delete unused. Prefer
  shared libraries over business one-offs."
- `.agents/skills/rallar-code-writing/references/repo-code-style.md` governs all code; canonical
  verbs, `Either` for expected failure, required fields, no role folders.
- Any commit to, push of or merge into `main` needs the maintainer's explicit approval for that
  operation. Pull requests land through the maintainer's review; marking ready is asked first.
- The `alm-observation/` files keep their names and contents: `playground/alm/tools/*.mjs` read
  them. The artifact that carries them is renamed (section 3), and the two documents that name it
  (`plans/README.md`, `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`) change
  with it.
- `deploy.yml` runs under one concurrency group that keeps a single pending run: a newer push
  cancels the pending one, Release Gate included. Nothing in this plan may lengthen a `deploy.yml`
  run.
- A lane inside `release-gate.yml` must carry `RALLAR_API_CONFIGURATION_PROFILE: prod-in-memory` and
  no `continue-on-error` (`packages/tests/repo/release-gate-lanes.test.ts`).
- The other ALM session appends decision rows to `playground/alm/alm-improvement-plan.md` (D701 is
  the last on `main`). This plan's row takes the next free number when its pull request is last
  updated before review, not a number fixed now.

## Words

The code uses "cell" for two things. This plan uses neither meaning without saying which:

- **scenario**: one entry of the conformance catalog, run over one carrier
  (`AlmLanePlannedCell` in `lane/resolve-alm-lane-plan.ts`).
- **family test**: one Playwright test, which runs every planned scenario of one family over one
  carrier (`ObservationCell` in the spec). Six families, three carriers, eighteen family tests.
- **run**: one job of one workflow run, for one carrier.

## Approaches

Three were weighed with the maintainer, who picked the first.

1. **One lane, two callers (picked).** Smoke moves into `release-gate.yml`; the observation workflow
   becomes the full scope on PostgreSQL, run for every `main` push and by the branch gate when the
   diff can change ALM; the ledger is computed on demand from each run's result file. Cost: the
   ledger's history ends where artifact retention ends. One thing changed after the pick, when the
   design was checked against the code: on `main` the observation starts from its own `push` trigger
   and is no longer a job of `deploy.yml` (section 2 says why).
2. **Full scope inside the Release Gate as non-required lanes.** One workflow, and promotion is one
   line. Rejected: the gate's run would stay in progress for the length of the full-scope jobs on
   every ALM pull request although its verdict is in; the repository keeps observations beside the
   gate for that reason.
3. **A scheduled sweeper that commits a ledger file.** A durable history in the repository.
   Rejected: CI would push to `main`, and a regression is found later than with a run per push.

## Design

### 1. The smoke lane is required

- `release-gate.yml` gains a lane `alm-smoke`: a matrix over the three carriers, one runner each,
  running `npm run test:rallar:full-stack:memory:alm` with `RALLAR_BLACK_BOX_ALM_CARRIERS` set to the
  carrier. The scope is not set, so the lane's default, `smoke`, applies. No `continue-on-error`.
- It records and uploads what the full-scope run does (section 3). The artifact names carry the
  scope, so the two never collide inside one workflow run.
- Both callers of `release-gate.yml` get it: the branch gate (in `broad` mode, like every lane) and
  the `main` push.
- Recent smoke jobs took 4.7 to 6.2 minutes; the lane's time limit is 15 minutes. It is not the
  longest lane.
- Evidence for requiring it now: the last 13 completed `main` pushes were green on all three
  carriers. The promotion rule is the same for both scopes (section 6), and smoke meets it.

### 2. The observation is the full scope on PostgreSQL

- `alm-conformance-observation.yml` runs the `full` scope against the PostgreSQL API: a
  `postgres:16` service and `npm run db:migrate` as the `postgres-integration` lane does, then
  `npm run test:rallar:full-stack:postgres:alm` with the carrier set. One runner per carrier, a fresh
  database per run. It stays an observation: `continue-on-error: true`, and no job waits for it.
- Its `alm_scope` input and the branch gate's `vars.RALLAR_BLACK_BOX_ALM_SCOPE` read are deleted;
  the workflow has one scope.
- It gains a `workflow_dispatch` trigger, so the full scope can be started on a branch
  (`gh workflow run alm-conformance-observation.yml --ref <branch>`). Its checkout already handles
  that event.
- **On `main` it starts itself.** The workflow gains a `push` trigger for `main`, with the same
  `paths-ignore` as `deploy.yml`, and no concurrency group: every push is observed in a run of its
  own. `deploy.yml` loses its `alm-conformance-observation` job. Why: a `deploy.yml` run lasts
  about 11 minutes today. With 30 to 60 minute jobs inside it, pushes that arrive meanwhile would
  queue behind it and cancel each other, and those commits would get no Release Gate on `main`.
- The branch gate still calls it (`workflow_call`) for a ready pull request in `broad` mode when
  the new job `alm-changes` says so (section 4). That is safe there: the branch gate's group is per
  pull request and cancels on a new push, and `pr:delivery` reads required checks only.
- **Time.** The full scope has never run on a GitHub runner. Family times recorded on a developer
  machine add up to 20 to 30 minutes per carrier, and `rtc` is the longest. The first build sets the
  job's limit to 60 minutes and measures. The rule after measuring: a carrier whose job took more
  than 30 minutes is split across two runners by family. The split needs a lane parameter that
  selects families (none exists; Playwright's `--shard` cannot split one spec file), decoded where
  the other lane parameters are (`lane/decode-alm-lane-parameters.ts`). That is slice 3, built only
  if the measurement asks for it.

### 3. Every run records every scenario's outcome

- Each family test writes one **lane result** file beside its observation files:
  `alm-lane-result/<carrier>-<scope>-<family>.json`.
- Contents: `carrier`, `scope`, `backend` (`memory` or `postgres`, from the reader the lane's API
  server already uses), `family`, and `scenarios`: one entry per planned scenario, in plan order,
  with its `scenarioKey` and an `outcome` of `passed`, `failed` or `not-run`. One more field,
  `familyOutcome`, is the family test's own outcome, because a family can fail outside any scenario
  (the identity check at its end, a start barrier, the time limit).
- The file is written when the family's plan is resolved, with every scenario `not-run`, and again
  after each scenario. A family that is cut off by its time limit or an error therefore leaves a
  true file: what ran, and what did not.
- A scenario's outcome is `failed` when its body threw or added a soft-assertion error, and `passed`
  otherwise. The record is built by a pure function in the lane's shared code
  (`packages/shared-test/rallar-bb-test/conformance/alm/`), not in the spec; the spec only calls it
  and writes the file.
- A family test that plans no scenario (four of six in the smoke scope) writes no file.
- **The run states its own plan first.** Before the first family starts, the run writes
  `alm-lane-result/<carrier>-<scope>-plan.json`: every family and the scenario keys it plans, from
  the same function the spec plans with. The ledger judges a run against that file, never against
  the catalog of the commit the ledger happens to run from. A family that is in the plan and has no
  result file was never started, and all its scenarios are `not-run`. How the plan file is written
  (a job step before Playwright, or the spec's first test) is the builder's, as long as there is one
  planning function.
- The job uploads two artifacts, both with `if: always()`:
  - `alm-conformance-lane-<carrier>-<scope>-<sha>`: the Playwright output root, as today but with
    the scope in its name;
  - `alm-lane-result-<carrier>-<scope>-<sha>`: the `alm-lane-result/` directory alone, so the
    ledger does not download snapshots.
- The commit, the event and the attempt are not in the file. The ledger reads them from the
  workflow run, which is their owner.

### 4. Which pull requests run the full scope

- A new branch-gate job, `alm-changes`, beside `game-changes` and shaped like it: it lists the
  changed paths (`git diff --name-only base head`) and decides.
- The decision is a pure function, tested on its own: the full scope runs unless **every** changed
  path is one that cannot change the lane. A path the function does not know runs the full scope.
- Paths that cannot change the lane:
  - documents: `docs/`, `plans/`, `playground/`, and `*.md` anywhere;
  - the games and their servers: `apps/ar-eye-hunter-v1/`, `apps/relic-hunters-v1/`,
    `apps/ar-eye-hunter-server-v1/`, `apps/relic-hunter-server-v1/`, `packages/relic-hunters/`,
    `packages/ar-eye-hunter/`, and their Playwright specs in `tests/playwright/ar-eye-hunter/` and
    `tests/playwright/relic-hunters/`;
  - unit tests: `packages/tests/`, except `packages/tests/repo/` (which pins the workflows);
  - the hosted fleet: `.github/workflows/hetzner-*`, `scripts/hosted-rallar/`.
- The builder confirms each entry against the tree before relying on it and drops one that the
  lane's processes do read. The list is a constant beside the function.
- It is an exclusion list on purpose: a missed dependency then costs runner minutes, not a
  regression.

### 5. The ledger

- **Pure core**, in `packages/shared-test/rallar-bb-test/conformance/alm/ledger/`: from a list of
  runs (commit, event, attempt, carrier, the job's conclusion, and that run's plan and lane result
  files) and the recorded causes, it computes:
  - per carrier, the **streak**: the number of most recent runs, newest first, that are green. A run
    is green when it is a first attempt, every family in its plan file has a result file, and every
    scenario in them `passed` with `familyOutcome` passed;
  - how a run that is not plainly green or red is read, by its job's conclusion: a job still in
    progress, cancelled or skipped is left out and does not break the streak; any other job without
    a plan file (it died before planning) is a red run with nothing to attribute;
  - per scenario (`carrier/family/scenarioKey`, and `carrier/family` for a failure outside any
    scenario), how many of the read runs failed it or did not run it, and in which runs;
  - the failed scenarios that have no recorded cause.
- **Which runs count.** The streak counts full-scope runs of `main` pushes only. Runs of pull
  requests and dispatched runs are read and shown beside it, because a red pull-request run may be
  the pull request's own regression, caught as intended, and not a flake.
- **Causes** live in one file in the repository,
  `packages/shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-flake-causes.json`: a list of
  entries with the scenario's key, the root cause in a sentence or two, and the pull request that
  fixed it, or `null` while it is open. The file starts empty. A decoder refuses a malformed file.
- **The command**, `npm run alm:lane:ledger`: a thin entry point that reads the recent runs of
  `alm-conformance-observation.yml` (its `push` runs for the streak; for the side list, its
  dispatched runs and the branch gate's runs that called it), with each job's conclusion, downloads
  each run's `alm-lane-result-*-full-*` artifacts, and prints the ledger. It reads GitHub through
  `gh`, the way `scripts/validation-evidence/github-validation-evidence.mjs` does. That file's run
  reader is generalised to take the event and status, and one artifact reader serves both callers;
  there is no second reader.
- It prints, per carrier: the streak against ten, the last red run with its failed scenarios, and
  the count of failures without a cause. It exits 0; it is a report, not a gate.

### 6. The promotion rule, restated

One rule for both scopes, replacing D639's wording where they differ:

- A carrier's lane may become required when its last ten counted runs are green with no rerun and
  every failure the ledger has read for that carrier has a recorded root cause.
- Smoke meets it on its history and becomes required in slice 1.
- For the full scope, the counted runs are on the PostgreSQL API. Making a carrier required is the
  maintainer's decision and its own pull request.

This goes into the roadmap as one decision row, with D639 named as amended.

### 7. What is deleted or rewritten

- The smoke observation: the `alm_scope` input, the repository-variable read, and every sentence
  that says the lane is smoke-only or wholly non-blocking.
- Tests that pin the old shape and must be rewritten first, as the failing tests of slice 1:
  - `packages/tests/repo/alm-observation-workflow.test.ts` (asserts the ALM job is not in
    `release-gate.yml`, and the memory script in the observation);
  - `packages/tests/repo/validation-evidence/branch-handoff-workflow.test.ts` (its `isAdmitted`
    needs `alm-changes`; the full-scope caller's admission is new);
  - `packages/tests/repo/release-gate-lanes.test.ts` (pins the new lane: a carrier matrix, not a
    shard);
  - `packages/tests/hetzner/deploy-release-gate.test.ts` (pins `deploy.yml`'s job list, which loses
    the ALM job).
- Documents that state the current shape: `CLAUDE.md` (the lane table and the paragraph after it),
  `packages/shared-test/rallar-bb-test/docs/alm-observation-artifact.md`,
  `docs/environment-variables.md` (the scope variable's prose),
  `playground/alm/alm-complete-product-description.md` (its validation baseline),
  `plans/active/deno-to-bun-validation.md` line 59. Historical decision rows are not rewritten.

## Slices

1. **The lane in CI.** Sections 1 to 4 and 7, and the decision row of section 6. Its own ready run is
   the measurement: the pull request changes the lane, so `alm-changes` selects the full scope.
   Acceptance: the smoke lane is green and required on the pull request; the three full-scope jobs
   complete on PostgreSQL and upload result files that name every planned scenario; their durations
   are recorded in the pull request.
2. **The ledger.** Section 5. Built test-first on result files shaped like slice 1's, then read
   against the real runs once slice 1 is on `main`. Acceptance: the command prints a streak and a
   failure list from real `main` runs, and flags the known flakes as having no cause.
3. **The family split**, only if a carrier's full-scope job took more than 30 minutes in slice 1.

After these, outside this plan: one slice per flake, most frequent first, each proven by repeated
dispatched runs; then promotion of a carrier when the ledger shows its streak.

## Decisions

The maintainer's, 2026-11-21, each asked alone:

| Question                           | Ruling                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------- |
| When the full scope runs           | "Main pushes plus ALM pull requests"                                        |
| Which API the full scope uses      | "Postgres for full, memory for smoke"                                       |
| How the streak and ledger are kept | "Computed from runs, causes in the repo"                                    |
| Known flaky scenarios              | "Honest lane, fixes follow the ledger"                                      |
| When smoke becomes required        | "In this work, on its existing streak"                                      |
| How it is built                    | "Approach 1: one lane, two callers"                                         |
| Method                             | "use sub-agent driven development and TDD", and the rules under Constraints |

The author's calls, open to correction:

- The full-scope selection is an exclusion list (section 4), so an unknown path runs the full scope.
- The streak counts `main` pushes only; pull-request and dispatched runs are shown beside it.
- The lane result is its own small file and artifact, not new fields of the observation regime,
  because it must exist when a family is cut off before its observation is written.
- The first full-scope time limit is 60 minutes, and the split rule is 30 minutes.
- A `workflow_dispatch` trigger on the observation workflow.
- Two pull requests (slices 1 and 2), not one.

Calls made after a reviewer read the design as a builder, each from a fact in the code:

- On `main` the observation runs from its own `push` trigger, not as a job of `deploy.yml`, because
  of `deploy.yml`'s concurrency group (section 2).
- Both artifacts carry the scope in their names, because the smoke lane and the full scope can
  upload in one workflow run and an artifact name must be unique there (section 3).
- Each run writes its own plan file first, so the ledger never judges an old run against today's
  catalog (section 3).
- The ledger reads each job's conclusion, not only the run's, to tell a cancelled or skipped job
  from one that died (section 5).

## Left to the builder

- The names of the result record's type and functions, within the code standard.
- How a scenario's failure is detected inside the three family runners of the spec, as long as the
  outcome rule of section 3 holds and the spec does not grow a second copy of it.
- The exact exclusion patterns of section 4, after checking them against the tree.
- The ledger's printed layout.
- Whether the full-scope job needs any environment the `postgres-integration` lane sets beyond the
  database URL; the measurement run shows it.

## Not established

- How long the full scope takes on a GitHub runner, per carrier, and whether a cold RTC handshake
  stays inside the recipe budgets there on the PostgreSQL API.
- Whether a dispatched run of a workflow whose `workflow_dispatch` trigger is not yet on `main`
  can be started from the branch. If it cannot, the first measurement is slice 1's ready run alone.
- The flake rate of any scenario on GitHub runners. The ledger is what will show it.
