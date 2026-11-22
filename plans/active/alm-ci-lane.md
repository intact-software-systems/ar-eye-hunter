# The ALM conformance lane in CI

The ALM conformance lane is the strongest proof ALM has, and almost none of it runs in CI. This plan
puts all of it there: the smoke scope becomes a required lane of the Release Gate, the full scope runs
on the PostgreSQL API for every push to `main` and for every pull request that can change ALM, and a
ledger computed from those runs says how close each carrier is to becoming required too.

Slice 1 (the lane in CI) is pull request #867; slice 2 (the ledger) is built on a branch stacked on
it. The maintainer decided the shape on 2026-11-21 (see "Decisions"). What the first ready run found
is near the end.

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
- **run**: a carrier's jobs in one workflow run, read together. A carrier is one job unless it is
  split by family (section 2).

## Approaches

Three were weighed with the maintainer, who picked the first.

1. **One lane, two callers (picked).** Smoke moves into `release-gate.yml`; the observation workflow
   becomes the full scope on PostgreSQL, run for every `main` push and for a pull request whose
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
- Recent smoke jobs took 4.7 to 6.2 minutes; the lane's time limit is 20 minutes. It is not the
  longest lane.
- Evidence for requiring it now: the last 13 completed `main` pushes were green on all three
  carriers. The promotion rule is the same for both scopes (section 6), and smoke meets it.

### 2. The observation is the full scope on PostgreSQL

- `alm-conformance-observation.yml` runs the `full` scope against the PostgreSQL API: a
  `postgres:16` service and `npm run db:migrate` as the `postgres-integration` lane does, then
  `npm run test:rallar:full-stack:postgres:alm` with the carrier set. One runner per job (a carrier
  is one job, or two when it is split by family, below), a fresh database per job. It stays an
  observation: `continue-on-error: true`, and no job waits for it.
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
- **On a pull request it starts itself too.** The workflow has a `pull_request` trigger (opened,
  synchronize, reopened, ready for review). Its first job decides whether the diff can change the
  lane (section 4); the lane jobs run for a pull request that is not a draft when that job says so,
  or when that job failed. Its concurrency group is per pull request and cancels on a new push;
  push and dispatched runs each get a group of their own. It is not a job of the branch gate,
  and `branch-release-gate.yml` loses its `alm-conformance-observation` job. Why: a job of the
  branch gate keeps that workflow run in progress until it ends, and the gate's evidence reuse
  reads only runs that completed in success. For 30 to 60 minutes after the required result a
  docs-only follow-up could not reuse the evidence, and any pull-request event in that window
  would cancel the run and lose it.
- **It checks out the event's own commit.** On a pull request that is the merge commit, so the
  observation tests what `main` would become, its artifact names carry the commit it tested, and a
  branch that predates this plan still finds the lane's action and scripts.
- **A hang ends as a failed step, not a cancelled job.** Both lane scripts run with Playwright's
  global timeout set below the job's time limit (14 minutes under a 20 minute limit for smoke, 55
  under 60 for the full scope), so the uploads run and the job concludes in failure.
- **Time.** Measured by the second ready run (below): `rtc-with-ws-fallback` 18.0 minutes, `ws`
  29.4, `rtc` 36.5. The rule: a carrier whose job took more than 30 minutes is split across two
  runners by family. So `rtc` runs as two jobs, each with its own runner and database:
  `two-agent,addressed,same-context` (16.6 minutes of family time in that run) and
  `three-agent,same-principal,four-role` (18.5). The other two carriers stay one job each.
  - The lane parameter `RALLAR_BLACK_BOX_ALM_FAMILIES` (a comma-separated list of family names;
    empty runs every family) selects the families a run executes. It is decoded with the other lane
    parameters in `lane/decode-alm-lane-parameters.ts`; a family test it does not select is skipped
    with that reason, and a key `RALLAR_BLACK_BOX_ALM_ONLY` names must run in a selected family.
  - The workflow's matrix lists its jobs as carrier and family list. A repository test fails unless
    every carrier is there and each carrier's family lists name every family exactly once.
  - A split job's name is `ALM conformance observation (<carrier>, <families>)`, and its two
    artifacts end in `-<families>` after the commit, so two jobs of one carrier never collide.
- **The per-family time limit.** A family test's own limit was 15 minutes, set from a developer
  machine. On a GitHub runner the two-agent family over `rtc` took 14.1 minutes. The limit is 25
  minutes, so a slow runner does not cut a healthy family off; the run's global timeout (55 minutes)
  still ends a hang.

### 3. Every run records every scenario's outcome

- Each family test writes one **lane result** file beside its observation files:
  `alm-lane-result/<carrier>-<scope>-<family>.json`.
- Contents: `carrier`, `scope`, `backend` (`memory` or `postgres`, from the reader the lane's API
  server already uses), `family`, and `scenarios`: one entry per planned scenario, in plan order,
  with its `scenarioKey` and an `outcome` of `passed`, `failed` or `not-run`. One more field,
  `familyOutcome`, is the family test's own outcome (`passed`, `failed`, or `not-finished` until the
  family ends), because a family can fail outside any scenario (an error opening or closing its
  pages, a start barrier, a recipe that never ends, the time limit). It is `failed` whenever the
  family test fails, whichever step failed.
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
  planning function. The plan names every family of the carrier, whichever families
  `RALLAR_BLACK_BOX_ALM_FAMILIES` lets the run execute: a carrier's two jobs write the same plan,
  so a job that is missing from the run altogether leaves its families without a result, which
  reads red.
- The job uploads two artifacts in a step of its own that runs `if: always()`. The uploads are not
  nested in the action that runs the lane: a composite action is one step of the job, and when that
  step is cancelled its nested steps are skipped, whatever their `if` says (seen in the first ready
  run). The two artifacts:
  - `alm-conformance-lane-<carrier>-<scope>-<sha>`: the Playwright output root, as today but with
    the scope in its name;
  - `alm-lane-result-<carrier>-<scope>-<sha>`: the `alm-lane-result/` directory alone, so the
    ledger does not download snapshots.
- The commit, the event and the attempt are not in the file. The ledger reads them from the
  workflow run, which is their owner.

### 4. Which pull requests run the full scope

- The observation workflow's first job on a pull request, `alm-changes`, reads the paths the pull
  request changes, from the merge base of its base and head to its head, so a branch that is behind
  `main` is not charged with what `main` changed. It reads them with the repository's shared reader
  (`scripts/repository-changes/read-git-changes.mjs`), which returns both paths of a rename.
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
  files) and the recorded causes, it computes, per carrier:
  - the **streak**: the number of most recent counted runs, newest first, that are green. A run is
    green when it is a first attempt, its job concluded in success, its plan plans at least one
    scenario, every family in its plan has a result, and every scenario in them `passed` with
    `familyOutcome` passed. Plan and results are compared by scenario key;
  - the **red runs with nothing to attribute**, each with its reason: a rerun (attempt above 1), a
    job that did not conclude in success although every recorded scenario passed, a job with no plan
    (it died before planning, or its artifact could not be read), a cancelled job, or a completed
    run in which no job of that carrier could be read at all;
  - per key (`carrier/family/scenarioKey`, and `carrier/family` for a failure outside any
    scenario), the runs that failed it and the runs that did not run it;
  - the **failures without a cause**, counted per run and family: every key that failed in a
    counted run; the family's own key, once, when the family is not green and no scenario of it
    failed (it never started, it was cut off, or its result is missing or refused); and a red run
    with nothing to attribute. A scenario that did not run is never counted by itself: when a
    scenario fails or throws, the ones after it do not run, and the failed one answers for them.
    Each counts when the causes file has no entry for it.
- **How a job's conclusion is read.** A job still in progress or skipped is left out and does not
  break the streak. A cancelled job of a pull-request run is left out and listed as such, because a
  newer push to the pull request cancels it by design. A cancelled job of a `main` push or of a
  dispatched run is red: those runs have a concurrency group of their own, so only a person or a
  dying runner cancels them (the first ready run of slice 1 showed a full-scope job that GitHub
  reported as cancelled after nine minutes, with no upload). A rerun makes every job of its run
  report the new attempt, so one rerun reddens all three carriers of that run; that is the rule's
  "no rerun".
- **A carrier's jobs are read as one run.** A carrier may run as several jobs of one workflow run
  (`rtc` runs as two). The ledger reads them together: the plan the jobs agree on, the results of
  all their artifacts, and one conclusion. That conclusion is in progress when any job is, else
  cancelled when any was, else a failure when any failed or when some were skipped and others not,
  else success when all succeeded, else skipped. Two jobs whose plans differ are reported as an
  issue. A rerun job uploads again under its own artifact name and GitHub lists both; the ledger
  reads each name once and says so. The plan is read only when every job of the carrier has a result
  artifact that could be read, counted by name. When one is missing, expired or could not be
  downloaded, the run has no plan and reads red with nothing to attribute, as a one-job carrier
  whose artifact is missing does. A dead runner or a failed download is the run's fault, not a
  family's: a cause recorded against a family key would answer for that family's later failures too.
- **Which runs count.** The streak counts full-scope runs of `main` pushes only, on the PostgreSQL
  API. Runs of pull requests and dispatched runs are read and shown beside it, because a red
  pull-request run may be the pull request's own regression, caught as intended, and not a flake. A
  push that changes only `performance-observations/**` starts no run and is not counted. History
  ends where artifact retention ends: an old run whose artifact has expired is reported as such and
  reads red, never green.
- **Causes** live in one file in the repository,
  `packages/shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-flake-causes.json`: a list of
  entries with a key, the root cause in a sentence or two, and the pull request that fixed it, or
  `null` while it is open. A key is a scenario key, a family key, or `<carrier>/run/<run id>` for a
  red run with nothing to attribute. The file starts empty. A decoder refuses a malformed file.
- **The command**, `npm run alm:lane:ledger`: a thin entry point that reads the recent runs of
  `alm-conformance-observation.yml`, each kind in its own query (`main` push runs up to the limit
  for the streak; pull-request and dispatched runs for the side list), with each job's conclusion,
  downloads every `alm-lane-result-<carrier>-full-<sha>…` artifact of the run, and prints the ledger. It
  reads GitHub through one shared reader, `scripts/github-actions/read-github-workflow-runs.mjs`,
  which the branch gate's evidence reuse uses too. The names it relies on (the lane job's name and
  the artifact's prefix) are pinned against the workflow and the action by a repository test.
- It prints, per carrier: the streak against ten and how many runs it was read from, the last red
  run with its reason and its failed and not-run keys, the red runs with nothing to attribute, and
  the count of failures without a cause; then the table of keys with each cause's state; the runs
  shown beside the streak; the jobs left out; and the issues met while reading. It exits 0 when it
  could read GitHub; it is a report, not a gate.

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
  - `packages/tests/repo/validation-evidence/branch-handoff-workflow.test.ts` (the branch gate
    no longer has an ALM job);
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
   It did: `rtc` took 36.5 minutes. Built as its own pull request, stacked on slice 2, because it
   changes what the ledger reads. Acceptance: a ready or dispatched run shows two `rtc` jobs, each
   under 30 minutes, and the ledger reads them as one `rtc` run.

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

Calls made after the whole-branch review of slice 1, each from a fact in the code:

- On a pull request the observation is its own workflow run, not a job of the branch gate, because
  the gate's evidence reuse reads only runs that completed in success (section 2).
- The observation checks out the event's own commit (section 2).
- The changed paths are read from the merge base, with the shared reader (section 4).
- Playwright's global timeout sits below each job's time limit (section 2).
- `familyOutcome` follows the family test's whole outcome, not only its scenarios' (section 3).

## What the first ready run found (2026-11-21)

The pull request's first ready run passed the Release Gate, with the three `alm-smoke` jobs green in
5.5 to 5.9 minutes each. The full scope did not complete on any carrier: `rtc` lost its runner after
52 minutes, and `ws` and `rtc-with-ws-fallback` were cancelled by GitHub 7 to 8.5 minutes into the
first family, with no upload.

The cause was in the lane's own harness, not in ALM. `readControlRun` and its siblings in
`tests/playwright/rallar-black-box/full-stack-helpers.ts` fetched the control run's snapshot through
Playwright's request fixture and never disposed the response. Playwright keeps every response body
until the fixture ends, which is the end of the family test, and the lane polls a snapshot that grows
with the run. Measured on a developer machine, the full scope over `ws`:

|                                     | Before  | After the fix |
| ----------------------------------- | ------- | ------------- |
| Playwright process, peak            | 33.1 GB | 3.5 GB        |
| The lane's whole process tree, peak | 38.5 GB | 9.0 GB        |

A GitHub runner has 16 GB. Every response the lane reads is now disposed through one function,
`tests/playwright/rallar-black-box/read-disposed-response.ts`, which the live-RTC and retention
clients use too. A job whose runner loses contact with GitHub still uploads nothing; no workflow
shape changes that.

## What the second ready run found (2026-11-22)

At the head `7c2934b60`, with the leak fixed, the Release Gate passed again (the three `alm-smoke`
jobs in 5.1 to 5.9 minutes), and the full scope ran to the end on every carrier on PostgreSQL and
uploaded both artifacts (run 45009025510):

| Carrier                | Job      | Scenarios       | Failed                                                                                      |
| ---------------------- | -------- | --------------- | ------------------------------------------------------------------------------------------- |
| `rtc-with-ws-fallback` | 18.0 min | 50 of 50 passed | none                                                                                        |
| `ws`                   | 29.4 min | 57 of 60 passed | four-role: `subscription-ordered-entry`, `-omission`, `-reconnect`                          |
| `rtc`                  | 36.5 min | 66 of 69 passed | two-agent: `churn-bounded-tracks`; four-role: `subscription-ordered-omission`, `-reconnect` |

- Under `continue-on-error` the jobs API reports a failed lane job as `failure`, the run concludes
  in `success`, and the upload step runs after the failed lane step.
- `rtc` passed the 30-minute rule, so slice 3 is built. Its family tests took 14.1 (two-agent), 1.1
  (addressed), 9.6 (three-agent), 1.5 (same-principal), 7.4 (four-role) and 1.4 minutes
  (same-context); the two-agent family ran within a minute of its own 15-minute limit.
- The failed scenarios are not diagnosed by this plan. They are the ledger's first entries, and each
  gets a fix slice of its own.

## What slice 3's ready run found (2026-11-22)

At the head `a5f1b9128` the full scope ran with `rtc` as two jobs on PostgreSQL (run 45039430280):

| Job                                           | Time     | Scenarios       | Failed                                                   |
| --------------------------------------------- | -------- | --------------- | -------------------------------------------------------- |
| `rtc`: two-agent, addressed, same-context     | 19.3 min | 37 of 38 passed | two-agent: `churn-bounded-tracks`                        |
| `rtc`: three-agent, same-principal, four-role | 20.4 min | 29 of 31 passed | four-role: `subscription-ordered-omission`, `-reconnect` |
| `rtc-with-ws-fallback`                        | 18.6 min | 50 of 50 passed | none                                                     |
| `ws`                                          | 25.7 min | 59 of 60 passed | four-role: `subscription-ordered-reconnect`              |

- Slice 3's acceptance is met: two `rtc` jobs, each under 30 minutes, which the ledger reads as one
  `rtc` run with no reading issue. Each job's plan file names all six families, and the artifact
  names ending in a family list (commas included) upload and download.
- The three failed `rtc` scenarios are the same three as in the second ready run of slice 1.
- A skipped matrix job is listed under its unevaluated name, `ALM conformance observation
  (${{ matrix.carrier }}…)`. The ledger's job-name pattern refuses it.
- The Release Gate of that run failed on one test: `tests-typecheck-maintained-project.test.ts`
  copies `scripts/check-tests-typecheck.mjs` into a temporary project, and slice 2 made that script
  import a module the test did not copy. Slice 2's focused test runs did not include that file. It
  is fixed on the ledger branch. The Release Gate has not run on the fixed head.

## What merging slice 1 does to open pull requests

A pull request's workflows come from its merge with `main`, but the Release Gate checks out the
pull request's head. After slice 1 is on `main`, a head that predates it has no
`.github/actions/alm-conformance-lane`, so its required `alm-smoke` lane fails until `main` is
merged into that branch. This is the one place where being behind `main` creates work, once per
open branch. No guard for old heads is built: it would be migration code. The pull request says
this, and the sessions with open branches are told.

## Left to the builder

- The names of the result record's type and functions, within the code standard.
- How a scenario's failure is detected inside the three family runners of the spec, as long as the
  outcome rule of section 3 holds and the spec does not grow a second copy of it.
- The exact exclusion patterns of section 4, after checking them against the tree.
- The ledger's printed layout.
- Whether the full-scope job needs any environment the `postgres-integration` lane sets beyond the
  database URL; the measurement run shows it.

## Not established

- How long a green full-scope `rtc` run takes on a GitHub runner: the measured run had three
  failed scenarios, which waited out their timeouts.
- Whether a dispatched run of a workflow whose `workflow_dispatch` trigger is not yet on `main`
  can be started from the branch. If it cannot, the first measurement is slice 1's ready run alone.
- The flake rate of any scenario on GitHub runners. The ledger is what will show it.
