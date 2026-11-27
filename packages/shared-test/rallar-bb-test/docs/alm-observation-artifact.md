# ALM Observation Artifact

The ALM conformance lane
(`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`) runs in CI in two scopes,
through one action, `.github/actions/alm-conformance-lane/action.yml`:

- the `smoke` scope on the in-memory API, as the required `alm-smoke` lane of
  `.github/workflows/release-gate.yml`;
- the `full` scope on the PostgreSQL API, as the `alm-conformance-observation` job of
  `.github/workflows/alm-conformance-observation.yml`. It is an observation: nothing waits for it,
  and no other workflow calls it. It starts itself on every `main` push except one that changes only
  `performance-observations/**`; on a pull request that is not a draft, when its own
  `alm-changes` job finds a path changed since the merge base that can change the lane (or that job
  fails); and on dispatch on any branch. It checks out the event's own commit: on a pull request,
  the merge commit.

Both run matrix legs by carrier, with Playwright's global timeout below the job's time limit (14
minutes under 20 for `smoke`, 55 under 60 for `full`), so a hang ends as a failed step. In the
`full` scope, `ws` and `rtc` each run as two legs split by family,
`two-agent,addressed,same-context` and `three-agent,same-principal,four-role`, because a carrier
whose job takes more than 30 minutes is split: `rtc` took 36.5 minutes as one job (run 45009025510)
and `ws` 31.6 minutes (run 45055329614). `rtc-with-ws-fallback` runs as one leg. A leg passes its
family list to both actions as the `families` input, which sets `RALLAR_BLACK_BOX_ALM_FAMILIES`; a
leg with an empty list runs every family. The lane job is named
`ALM conformance observation (<carrier>)`, or
`ALM conformance observation (<carrier>, <families>)` for a split leg. The job uploads the results
through a second action, `.github/actions/alm-conformance-lane-results/action.yml`, as its next step
with `always()`: a cancelled composite step skips its own remaining steps, so the uploads are a step
of the job and also run for a cancelled job. Each leg uploads two artifacts, pass, fail or
cancelled, each when it has files: the whole Playwright output root,
`apps/rallar-black-box/test-results`, as `alm-conformance-lane-<carrier>-<scope>-<sha>` (kept seven
days), and its `alm-lane-result/` directory alone as `alm-lane-result-<carrier>-<scope>-<sha>` (see
"The lane result files" below). A split leg appends `-<families>` to both names, for example
`alm-lane-result-rtc-full-<sha>-two-agent,addressed,same-context`, so the two legs of one carrier
never upload under one name; the `smoke` lane passes no families and its names carry no suffix.
`<sha>` is the workflow run's commit. On a Release Gate run of a pull request that is the merge
commit, while the `alm-smoke` lane checked out the pull request's head.

Every cell — one carrier per cell, pass or fail — writes these files into that root:

| File                                                                   | Contents                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `test-results/alm-observation/<carrier>-<scope>.json`                  | The `ALMObservationRegime` described below.                  |
| `test-results/alm-observation/<carrier>-<scope>-snapshot.json`         | The cell's complete control run snapshot.                    |
| `test-results/alm-observation/<carrier>-<scope>-page-diagnostics.json` | The lane's raw `pageerror`/console capture (Task 7b, below). |

A three-agent cell (the `three-agent family over <carrier>` test, which runs only the scenarios that
declare `recipient-b`, D45) writes the same three files as `<carrier>-<scope>-three-agent*.json`, and
its job log line ends in `family=three-agent`. Its page-diagnostics file carries all three pages, with
role `sender`, `receiver` or `recipient-b`. The snapshot decoder attributes only the `alm-sender-` and
`alm-receiver-` agent ids, so the inbound events of the `recipient-b` page read `unattributed`.

A four-role cell (the `four-role family over <carrier>` test, which runs only the topic subscription
scenarios of the `four-role` lane family) writes the same three files as
`<carrier>-<scope>-four-role*.json`, and its job log line ends in `family=four-role`. Its
page-diagnostics file carries all four pages, with role `sender`, `publisher-b`, `receiver` or
`sibling`; the `publisher-b` and `sibling` agent ids start `alm-publisher-b-` and `alm-sibling-`, which
the snapshot decoder does not attribute, so their inbound events read `unattributed`.

A same-context cell (the `same-context family over <carrier>` test, which runs only the scenarios of
the `same-context` lane family) writes the same three files as `<carrier>-<scope>-same-context*.json`,
and its job log line ends in `family=same-context`. Its page-diagnostics file carries the sender's and
the receiver's pages and each scenario's successor page, with role `successor`. The successor's agent
ids start `alm-successor-`, which the snapshot decoder does not attribute, so its events read
`unattributed`.

The control run snapshot also carries each page's `rallar.browser.state-read` events (the state-read
diagnostics of the runtime diagnostic contract), so a cell can tell when a page pulled or reconciled
group state by `operation` and `result`, and its `rallar.browser.group_state.applied` events, which
state the group revision the page's cache holds.

They live beside the per-test output directories rather than inside one, because Playwright deletes
a passing test's own directory at the end of the run. A failed cell additionally attaches its
snapshot to the Playwright report, which is where it has always been; a green cell used to leave no
evidence at all. The page-diagnostics file is written only when at least one agent page attached a
capture; every real lane run does, so its absence marks an artifact from before Task 7b.

The cell also prints one line to the job log:

```text
ALM observation ws-smoke: regime=normal perOperation=8.67 ms/op over 15 commits outcome=passed page=normal (2 ms/probe over 34)
ALM observation ws-smoke: regime=normal (page) perOperation=unmeasured (1 commits) outcome=passed page=normal (1 ms/probe over 52)
```

The second shape is a cell with too few durable send commits to measure: `(page)` says the page regime
decided `regime`.

## The lane result files

The observation files describe how a family test ran; the lane result files say which planned
scenarios ran and with what outcome, so a family test cut off by its time limit or an error still
leaves a true record. The spec writes them into `test-results/alm-lane-result/`, beside the
observation files and for the same reason, with the pure builders of
`packages/shared-test/rallar-bb-test/conformance/alm/lane-result/alm-lane-result.ts`.

| File                                                           | Written by                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| `test-results/alm-lane-result/<carrier>-<scope>-plan.json`     | The first test of each carrier, `lane plan over <carrier> (<scope>)`. |
| `test-results/alm-lane-result/<carrier>-<scope>-<family>.json` | Each family test that plans at least one scenario.                    |

The **plan file** states the run's plan before any family test of its carrier starts: `carrier`,
`scope`, `backend` (`memory` or `postgres`, the API the full-stack configuration starts), and
`families`, every lane family with the `scenarioKeys` it plans. A family that plans nothing is
listed with no keys; in a run not narrowed by `RALLAR_BLACK_BOX_ALM_ONLY` or `_SKIP`, a carrier
whose families plan nothing fails its plan test, and a narrowed run writes its plan as it is. In the
`full` scope a run that is not narrowed also fails its plan test when the plan leaves out a lane
cell the carrier matrix names over its carrier ([ALM carrier matrix](./alm-carrier-matrix.md)). It
comes from the same planning function the family tests run, so a run is judged against its own plan,
not against a later catalog. The keys are in the plan test's own order: a `shuffled` family that
names no seed mints one per planning, so its run order may differ. Compare a plan with a result by
key.

A **family result file** carries the same `carrier`, `scope` and `backend`, its `family`,
`familyOutcome`, and `scenarios`: one `{ scenarioKey, outcome }` per planned scenario, in plan
order, and nothing the plan does not name. The family test writes it when its plan is resolved, with
every scenario `not-run`, again after each scenario, and once more at its end, each time through a
temporary file and a rename, so a worker killed mid-write leaves the previous complete file.

- A scenario's `outcome` is `failed` when its body threw or added a soft-assertion error to the
  family test, `passed` when it ended otherwise, and `not-run` when it never ended: the family test
  stopped before it, on an earlier error, a start barrier or the time limit.
- `familyOutcome` is `not-finished` until the family test's whole body ends, from opening its pages
  to closing them, then `failed` when that body threw or left an error on the test, and `passed`
  otherwise. A family can fail outside every scenario (opening or closing its pages, a start
  barrier, a root that never ends), so a `failed` family may hold only `passed` scenarios. A family
  test cut off before its body ended, by its time limit or the run's global timeout, leaves
  `not-finished`, unless its abandoned body rejects during teardown, which writes `failed`; either
  way the family is not `passed`.
- A family whose plan names scenarios but has no result file was never started; every scenario it
  plans is `not-run`.

The commit, the event and the attempt are not in the files; the workflow run that uploaded the
`alm-lane-result-<carrier>-<scope>-<sha>` artifact (with `-<families>` for a split leg) owns them.

## The ledger

`npm run alm:lane:ledger` reads, through `gh`, the newest `main` push runs of
`alm-conformance-observation.yml`, and beside them its newest pull-request runs and its newest
dispatched runs, each kind read on its own so that pull-request traffic cannot crowd the push runs
out of the window. It downloads every `alm-lane-result-<carrier>-full-<sha>` artifact of a run
(with `-<families>` for a job of a split carrier) and prints the ledger. It only reads GitHub. Options: `--limit <n>`
(the `main` push runs to read, 1 to 100, default 30; at most as many pull-request and as many
dispatched runs are read beside them) and `--repository <owner/name>` (default: the repository
`gh repo view` resolves for the working directory), for example
`npm run alm:lane:ledger -- --limit 50`. An option given twice is refused.

It exits 0 whenever it could read GitHub, red or green; it is a report, not a gate. A causes file
that cannot be read, is not JSON, or does not decode is printed as an issue, and the ledger is then
read with no causes. It exits 1 only when it could not read GitHub (no `gh`, no access) or an
option is wrong.

The logic is pure and lives in `packages/shared-test/rallar-bb-test/conformance/alm/ledger/`; the
entry point, `alm-lane-ledger.mts`, only reads GitHub and files and prints. The names it relies
on, the lane job's name and the result artifact's prefix, are pinned against the workflow and the
`alm-conformance-lane-results` action by `packages/tests/repo/alm-lane-ledger-workflow-names.test.ts`.

### How a run is read

- A lane job is `ALM conformance observation (<carrier>)`, or
  `ALM conformance observation (<carrier>, <families>)` for one job of a carrier split by family
  (`ws` and `rtc` each run as two); other jobs, such as `Detect ALM lane changes`, are not read.
  The carrier comes from the job's name. A completed `main` push or dispatched run in which no job
  of a carrier could be read is red for that carrier (reason `no-job-read`) and named as an issue. A
  run that was skipped as a whole is not asked for its jobs or artifacts.
- **A carrier's jobs are read as one run.** Every job of a carrier in a workflow run makes one run
  of that carrier, read from every artifact whose name starts with
  `alm-lane-result-<carrier>-full-`, each name once (see the rerun rule below): the plan the jobs
  agree on, the results of all the artifacts, and one conclusion. Each job writes the whole
  carrier's plan, so the plans are equal; jobs whose plans differ (other families, or other scenario
  keys or order) are named as an issue, `the plans of this carrier's jobs differ; read the first.`,
  and the first is read. A second plan inside one artifact, and a second result for one family
  across all of them, are issues too. An expired or undownloadable artifact is named on its own. The
  plan is read only when every job of the carrier has a result artifact that could be read, counted
  by name: when one is missing, expired or could not be downloaded, the run has no plan and reads
  red with nothing to attribute (`no-plan`), as a one-job carrier whose artifact is missing does, so
  a dead runner or a failed download is the run's fault, not a family's. For a split carrier this is
  named as an issue, `<k> of <n> jobs has a readable result artifact; the plan is not read.` (`have`
  when k is not 1). A job missing from the run altogether leaves its families without a result, so
  the carrier reads red with those families' keys.
- The jobs' one conclusion is `in-progress` when any job is still running; else `cancelled` when
  any was cancelled; else `failure` when any failed, or when some were skipped and others were not;
  else `success` when all succeeded; else `skipped`. A carrier with one job reads that job's
  conclusion.
- GitHub's job conclusion maps onto the ledger's values: still running is `in-progress`; `success`,
  `skipped` and `cancelled` keep their names; every other conclusion (`failure`, `timed_out`,
  `startup_failure`, ...) is `failure`. A job under `continue-on-error: true` that failed is
  reported as `failure`.
- A run is **green** when it is a first attempt, its job succeeded, its plan plans at least one
  scenario, and every planned family has a result whose scenarios all `passed` and whose
  `familyOutcome` is `passed`. A planned family without a result file was never started, so its
  scenarios did not run.
- A file of the artifact must state the job's carrier, scope `full` and backend `postgres`; a file
  that disagrees, is not JSON, or does not decode is an issue and read as absent. A first-attempt
  job that was not cancelled and whose plan is absent reads red with the reason `no-plan` (see the
  order of reasons below).
- **The streak counts `main` push runs only**, per carrier, newest first, up to the first that is
  not green. Pull-request and dispatched runs are shown beside it: a red pull-request run may be
  that pull request's own regression, caught as intended. A job still running or skipped is left
  out and does not break the streak; so is a cancelled job of a pull-request run, since a newer push
  to the pull request cancels it by design. A cancelled job of a `main` push or of a dispatched run
  is red: those runs have a concurrency group of their own, so only a person or a dying runner
  cancels them.
- **A rerun reddens every carrier of its run.** After "re-run failed jobs" every job of the run,
  including the ones carried over unchanged, reports the new `run_attempt` (seen on run
  44941158105 of this repository), and a run read at attempt 2 or later is never green. A job that
  runs again uploads again under its own artifact name, and GitHub lists the name twice, while a
  download by name returns one copy, the newer. The ledger downloads and reads each name once, keeps
  the first listing's expiry, and names it as an issue,
  `artifact <name> is listed <n> times (a rerun uploads again under its job's name); read once.`;
  a job carried over unchanged uploads nothing new.
- **History ends at artifact retention.** An old run whose artifact has expired is named as an issue
  and reads red, never green: with the reason `no-plan` for a first-attempt job that was not
  cancelled. A `main` push that changes only
  `performance-observations/**` starts no run and is not counted.

### Red runs with nothing to attribute

A red run that names no key is listed under its carrier with one reason, chosen in this order,
the first that applies: `no-job-read`, `rerun`, `cancelled`, `no-plan`, `plan-plans-nothing`,
`job-not-success`. So a rerun whose artifact has expired reads `rerun`, and a cancelled job with
no plan reads `cancelled`.

| Reason               | The run                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rerun`              | was read at attempt 2 or later.                                                                                                                   |
| `job-not-success`    | has a job that did not succeed although every recorded scenario passed.                                                                           |
| `no-plan`            | has no plan: a job died before planning, or a job of the carrier has no result artifact that could be read (missing, expired, or not downloaded). |
| `cancelled`          | has a cancelled job (a `main` push or dispatched run).                                                                                            |
| `no-job-read`        | completed with no job of the carrier that could be read.                                                                                          |
| `plan-plans-nothing` | has a plan that plans no scenario at all.                                                                                                         |

### Failures without a cause

A **key** is `carrier/family/scenarioKey`, or `carrier/family` for a failure outside every
scenario (a family that failed while all its scenarios passed, a result its plan does not name, a
result for another carrier, or a second result for one family). Per counted run and family, the
failures that need a cause are:

- every key that **failed**;
- the family's own key, **once**, when the family is not green and no key of it failed: it never
  started, it was cut off, or its result is missing or refused;
- `carrier/run/<run id>` for a red run with nothing to attribute.

A scenario that did not run is never counted by itself: when a scenario fails or throws, the ones
after it do not run, and the failed one answers for them. Each counts as a **failure without a
cause** while the causes file has no entry for its key. The count is of distinct keys per carrier:
a key that failed in several runs counts once, and one cause entry clears it in every run. A carrier may become required when its
streak reaches ten with no rerun and that count is 0; making it required stays the maintainer's
decision.

### The output

```text
ALM lane ledger: read 30 main push, 30 pull-request and 2 dispatched runs; main push runs from 1a2b3c4 (newest) to 9f8e7d6 (oldest).

Streak of green main-push runs, per carrier:
ws: streak 7/10 of 30 runs read
  last red: run 44900000001 at 5d6e7f8, attempt 1, job failure, plan read
    failed:
      ws/two-agent/fenced-catch-up
    not run:
      ws/two-agent/ordered-burst
  red runs with nothing to attribute: none
  failures without a cause: 1
    ws/two-agent/fenced-catch-up
...
```

- **Header**: how many runs of each kind were read, and the `main` push window's own newest and
  oldest commit.
- **Per carrier**: `streak <n>/10 of <m> runs read` (a streak equal to the runs read is bounded by
  the window), then the newest red push run with its attempt, job conclusion, whether a plan was
  read, its reason when it names no key, and its failed and not-run keys (ten each at most, then
  `and <k> more`); the carrier's red runs with nothing to attribute, with their reasons; and
  `failures without a cause` with its count, followed by the keys themselves (ten at most, then
  `and <k> more`), spelled exactly as a cause entry's `key` must be, `carrier/run/<run id>` keys
  included.
- **Keys failed or not run in main-push runs**: every key, sorted, with the push runs that failed
  it, the push runs that did not run it, and its cause: `open` while `fixedByPullRequest` is null,
  `#<n>` once fixed, and, with no entry, `none` for a key that failed and `-` for a key that only
  did not run (it never needs a cause). A family key that answers for a cut-off or never-started
  family is in no row of this table; it is listed under its carrier's failures without a cause.
- **Pull-request and dispatched runs**: run id, event, carrier, green or red.
- **Jobs left out**: running, skipped, or a cancelled pull-request job, with the job's conclusion.
- **Issues met while reading** (ten at most, then `and <k> more`): files refused or undecodable,
  a carrier with no job read, an expired or undownloadable artifact, a causes file that could not
  be read or decoded.

Each section that is empty prints one line saying so.

### Recording a cause

When a failure's root cause is known, add an entry to
`packages/shared-test/rallar-bb-test/conformance/alm/ledger/alm-lane-flake-causes.json`. The file is
a JSON array; each entry has a `key` exactly as the ledger prints it under `failures without a
cause`, the `cause` in a sentence or
two, and `fixedByPullRequest`: the pull request that fixed it, or `null` while it is open. A key
appears at most once, and must have one of three forms, with a known carrier and family:

- a scenario: `rtc/two-agent/fenced-catch-up`;
- a family, for a failure outside every scenario or a family cut off before any scenario failed:
  `ws/four-role`;
- a red run with nothing to attribute: `rtc-with-ws-fallback/run/44955838821`.

```json
[
  {
    "key": "rtc/two-agent/fenced-catch-up",
    "cause": "The receiver's roster read raced the relay's reshape, so the first frame met a stale fence.",
    "fixedByPullRequest": null
  },
  {
    "key": "rtc-with-ws-fallback/run/44955838821",
    "cause": "The runner was lost mid-job; nothing was uploaded.",
    "fixedByPullRequest": null
  }
]
```

## The budgets stay

Maintainer decision, 2026-09-11: the harness budgets are not the thing under test and are not
adjusted to make a run green.

- `CONNECT_READINESS_TIMEOUT_MS` 30 000 — a cold RTC handshake on a fresh server exceeds the message
  deadline, so connect budgets are harness budgets rather than product deadlines.
- The receiver window is derived: `deadlineMs` (18 000 in the lane) plus
  `NON_EXPIRING_SEND_TIMEOUT_MS` for a positive observation, and the bare `deadlineMs` for an
  absence proof. A durable positive wait (`durable-opt-in`'s `received-1`) carries one more
  `NON_EXPIRING_SEND_TIMEOUT_MS` for the durable admission commit and drain it must additionally
  cover (R-S3b-20).
- `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000 — hosted conformance may need more than five seconds to
  admit a non-expiring send.

Both constants live in
[`conformance/alm/alm-conformance-budgets.ts`](../conformance/alm/alm-conformance-budgets.ts); the receiver
window is derived from them in
[`conformance/alm/alm-conformance-receiver-commands.ts`](../conformance/alm/alm-conformance-receiver-commands.ts).

Other budgets were added or raised where a GitHub runner's work outlasted the wait that covered it, not
where a product deadline was missed: `churn-bounded-tracks` extends its recipes' run budget by its
receiver's count, which fails on a stall rather than a fixed window, and `buffered-track-drains` by its
cue wait; a family's limit is 35 minutes
([`conformance/alm/lane/alm-lane-family-timeout-ms.ts`](../conformance/alm/lane/alm-lane-family-timeout-ms.ts));
a publish loop's attempt observes for 15 s, and a publication published once gives its one send the same
15 s to reach durable admission; a poll starts its attempts for one phase and its deadline
runs one attempt's budget past it; a `connected` barrier counts a connect's readiness wait; the
`own-share-under-inbound` flood has the 30 s an arrival counts, the buffered sends a budget of 2,000 ms
a send, while the churn's 280 sends have only a 600 s ceiling, each send's own timeout bounding its
iteration; and the buffered track's sends live for a lifetime derived from the buffered sends' budget,
not a flat 90 s.

## The regime file

`ALMObservationRegime`
([`conformance/alm/observation/compute-alm-observation-regime.ts`](../conformance/alm/observation/compute-alm-observation-regime.ts))
records what the runner was doing while the cell ran:

- `cellOrder` — `{ mode, seed, rooms, scenarioKeys }`: how the family's cells ran, as the lane plan
  ([`conformance/alm/lane/resolve-alm-lane-plan.ts`](../conformance/alm/lane/resolve-alm-lane-plan.ts))
  decided it from the lane parameters, whose defaults, refusals, composition and replay
  [`docs/environment-variables.md`](../../../../docs/environment-variables.md) holds. `mode` is `declared`
  (the catalog order) or `shuffled`; `seed` is the seed a shuffled family used, given or minted, and
  `null` for `declared`; `rooms` is `family` (one room for the family) or `cell` (a room of its own
  per cell) as the family ran it: a same-context family reads `family`, whatever was asked. A cell
  whose definition declares a room of its own (`room: 'own'`: `subscription-ordered-reconnect`) runs in one
  under either value, and the family's shared-room cells after it run in a fresh shared room;
  `scenarioKeys` lists the cells in the order they ran. In a room the family shares, a cell that reshapes the
  room's topology (its definition declares `roomTopology: 'reshaped'`) runs after every cell that keeps it; a
  shuffle permutes within the two groups. The job-log line ends in `order=… seed=… rooms=…` (`seed=none` for `declared`).
- `regime` — `normal`, `slow`, or `unclassified`: `perOperation`'s class when it is measured,
  otherwise `pageRegime.regime` (R-S3a-16).
- `regimeSource` — `per-operation` or `page`: which of the two decided `regime`. The job-log line
  prints `(page)` after `regime=` for the second.
- `perOperation` — the median admission read cost, `readDurationMs / readOperationCount`, over the
  `send`-origin commits of the whole cell, from the `commit-phases` events of the
  [outbound admission diagnostics](./runtime-diagnostic-contract.md). It is `too-few-samples` below
  `ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT` samples. Only `send`-origin commits count, because a
  drain's commit measures a different read chain than a caller's own admission.
  - Only commits whose `lane` is `durable` count (R-S3a-15); a `checkpoint` lane commits to its memory
    pair, as `volatile` does, and is left out with it. The 30 / 35 ms thresholds were
    calibrated on IndexedDB read chains; a memory lane's commit reads no IndexedDB, and its cost is
    the page's event-loop contention instead: 0–5 ms per operation for a send and up to 39 ms for a
    repair on a local run, figures that say nothing about the runner's storage. An event recorded
    before S3a names no lane and is read as `durable`. That default is exact only for artifacts
    recorded before the volatile lane existed: an artifact from an S3a branch head between the store
    lanes (S3a Tasks 4–5) and R-S3a-15 carries memory-lane events with no `lane`, reads them as
    durable, and is no regime baseline.
  - The calibration read the cell's opening window. Since S3a's volatile default a cell's first
    durable send comes from `durable-opt-in`, well past it, so the reading spans the whole cell
    (R-S3a-16). A cell that sent too few durable messages leaves `regime` to the page.
  - The trade-off: the durable send commits now come after whatever degradation the cell causes
    itself, so a failing cell that reaches the sample floor can read `slow` from its own IndexedDB
    contention, and a product red then reads as a slow runner — the misread this file exists to
    prevent. When `regime` says `slow` and `pageRegime.regime` says `normal`, suspect the cell before
    the runner, and read the snapshot.
- `windowMs` — `ALM_OBSERVATION_WINDOW_MS`, measured from the run's earliest event: where the
  `pageRegime` window opens.
- `pageRegime` — the page's storage queue, beside `regime`'s admission chain. It is the median
  `durationMs` of the outbound `age-bound` `readiness-probe` events, over both roles, from
  `ALM_OBSERVATION_WINDOW_MS` to `ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event: an
  `age-bound` probe is a fixed-shape storage read taken only because the remembered answer aged out,
  so its duration reads how long the read queued behind the page's other IndexedDB transactions
  rather than anything about the admission chain itself. The window is deferred past the outbound
  regime's own opening window because page start-up contends too. `{ outcome: 'unmeasured',
  sampleCount, regime: 'unclassified' }` below `ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT` samples;
  otherwise `{ outcome: 'measured', storageProbeMedianMs, sampleCount, regime }`. Only probes whose
  `lane` is `durable` count: a memory lane's `…/volatile` owner probes at 0 ms and would pull the
  median of a slow page toward `normal`. A snapshot that holds the control server's default event
  bound (`ALM_OBSERVATION_CONTROL_SERVER_RETAINED_EVENTS`, 2 000) reads `{ outcome: 'unmeasured', sampleCount: 0,
  regime: 'unclassified' }`: the server drops a run's oldest events past that bound, so the earliest
  event it kept may be from mid-run and the window measured from it is not the run's opening one.
- `peerReadiness` — per lifecycle stream and peer, the time from first known to first ready, or
  `never-ready` with how long the peer was observed.
- `scenarioSends` — each recipe run's wall clock, or, for a run that failed, the failing step's
  error code. A failed recipe run carries no result object, so it has no duration to report.
- `workPageRate` — `work-page` storage operations per second over the span from the cell's first to
  its last `storage.counters` reading, summed over every page that read its counters (senders and,
  since S3a's storage windows, receivers). Each page counts from its own previous reading; it counts
  from zero after a reading that reset the counter, and after a reading lower than its previous one,
  which is a reloaded page whose counter started again. That rule catches only a lower reading: a
  reloaded page whose counter passed the old page's last reading before its next reading is
  under-counted by that last reading.
- `inbound` — one entry per direction (`sender`, `receiver`, `unattributed`), from the
  `admission-outcome`, `effect-drain` and `claim-settled` events of the
  [inbound admission diagnostics](./runtime-diagnostic-contract.md). The direction is resolved from
  the lane's `alm-<role>` agent id prefix; any other id is `unattributed` rather than guessed. `[]`
  when the cell carried no inbound event at all; otherwise every direction is reported, `no-events`
  for one that carried none of the three kinds. The decoded snapshot keeps each `admission-outcome`'s
  `msgId`, `carrier` and `reason` beside its `outcome`, so one message arriving over both carriers
  reads as two outcomes for one `msgId`. In the `cross-carrier-duplicate` scenario, the receiver shows
  one `committed`/`admitted` and one `not-handled`/`duplicate` for the pair's `msgId`, the refused copy the one on
  carrier `ws`. In `not-yet-in-sync`, and in
  `fenced-catch-up` over `rtc` before the roster moves, the receiver's refusal reads `rejected` over
  `rtc` with a reason starting `not-yet-in-sync`. A measured direction carries:
  - `pendingShare` — `{ outcome: 'measured', pendingSharePercent, outcomeCount }`, the share of
    `admission-outcome` events on that direction whose outcome was `pending`, out of `outcomeCount`;
    the count is of events, not messages: a retained admission's replay states its own event, so a
    message whose every attempt's commit conflicted, or that waits for its first delivery, counts its
    ingress `pending`, a further `pending` for each replay that ended so again, and its replay's
    verdict; a conflict that the same call's next attempt recovers counts no `pending`, so the share
    reads lower for the same traffic than a single attempt's would;
    or `{ outcome: 'unmeasured' }` when the direction reported `effect-drain` events but no
    `admission-outcome` event, because a percentage over zero outcomes is not a measurement. The
    drain medians beside it are still reported in that case.
  - `phases` — the median of each `effect-drain` phase (`selectionMedianMs`, `claimMedianMs`,
    `runMedianMs`, `releaseMedianMs`, `queueWaitMedianMs`) and of `durationMs` itself
    (`drainMedianMs`), over `drainCount` drains, taken over the whole cell: this block reads the
    receiver rather than the runner. Only drains whose `lane` is `durable` count, as in `regime`
    (R-S3a-15): the F2b and F2c figures were measured when every inbound owner was IndexedDB, and a
    memory lane's single-digit drains would pull a slow receiver's medians into the normal band. An
    event recorded before S3a names no lane and is read as `durable`. `drainCount: 0` with every median at `0` means the direction reported admission outcomes
    but no drain — the mirror of `pendingShare`'s `unmeasured` case above. As the diagnostic contract
    explains, the four phases do not sum to `durationMs`, and — since Task 2 of the F2c slice —
    `releaseMedianMs` is the median of one release flush per batch, not one flush per claim. F2c's
    acceptance figure for the inbound pending share and drain phases is read from this block, not
    from a session script.
  - `claimWaits` — the delivery wait split at its two instants, from the `claim-settled` events on
    that direction: `reservationWaitMedianMs`, the median `batchStartedAtMs − dueAtMs` over the
    `dispatch-local` claims — from due to the run-loop start of the batch that ran the claim: the
    wait for a round to take the row plus that batch's own selection and reservation, which the
    `phases` medians carry for subtracting — and `intraBatchWaitMedianMs`, the median
    `startedAtMs − batchStartedAtMs` over the same claims, the serialization behind earlier claims in
    the same run loop and nothing else, over `dispatchClaimCount` claims; and `sendControlClaimMedianMs`, the median
    `durationMs` of the `send-control` claims, over `sendControlClaimCount`. Whole-cell medians over
    the `durable` lane's claims, like `phases`; every figure is `0` with a count of `0` when the direction ran no such claim, and a
    `claim-settled` event missing `durationMs`, `dueAtMs`, `batchStartedAtMs` or `startedAtMs` (one
    emitted before the three instants existed) is skipped rather than counted. `dueAtMs` is read from
    the reserved entry, and a reservation clears a retried row's retry stamp, so a claim of a row that
    had been retried reports its wait from when the row was written, not from its latest retry due
    time; a `reservationWaitMedianMs` over retried rows is an upper bound.
  - `promotedReleases` — the sum of `promoted` over every `effect-drain` of that direction, on both
    lanes (a volatile track is released on the memory lane): the buffered releases its batches ran
    right after their predecessor (D190). An `effect-drain` that states no `promoted` (one recorded
    before D190) is skipped, as a drain missing any other field is. **Caveat:** under the control
    server's default bound of 2 000 retained events a long fast run drops its early drains, so
    `promotedReleases` can read `0` and `pageRegime` `unmeasured` although the fairness cells' own
    witnesses passed; the lane's scripts retain every event for that reason.
- `cellOutcome` — `passed` or `failed`, including a soft-assertion failure.
- `pageDiagnostics` — the lane's `pageerror`/console capture, folded from the cell's
  `-page-diagnostics.json` file. It captures page-level errors only and does not by itself prove
  where a frame was lost; it names the page it happened on, and where in the cell's timeline, for the
  next hosted red to correlate against the control snapshot's own events. `{ outcome: 'not-captured' }`
  when the lane did not supply the file at all — an artifact from before Task 7b, not a page that
  raised nothing. Otherwise `{ outcome: 'captured', counts, dropped, first }`: `counts` is the number
  of `pageerror`, `console-error` (`consoleError`) and `console-warning` (`consoleWarning`) records;
  `dropped` is how many more the lane's 200-per-page cap discarded; `first` is the earliest 20 records
  across the agent pages, each `{ agentId, role, atMs, kind, message, stack? }` with `atMs` relative
  to the cell's first control event when the snapshot decoded, else the earlier page's own creation.
- `ledger` — the session ledgers' fullest reading (D180), from the `rallar.alm` block of each `stats`
  command's result: every ALM recipe ends with one, so each page reads its ledger once per cell. The
  decoded snapshot keeps each reading as `ledgerReadings`, `{ atEpochMs, agentId, usage, own, inbound,
  overloaded, orderingTracks }` per agent; the control client's periodic stats read no page, carry no
  `alm`, and are skipped, as is a reading whose block does not decode (one without its pools, its
  `orderingTracks` or its `publication` stage report included; the ledger keeps no publication
  field). `{ outcome: 'measured', readingCount, maxAdmissions, maxBytes,
  maxOldestAgeMs, maxTracks, maxInboundAdmissions, maxInboundBytes, maxOrderingTracks,
  overloadedReadings }`: each maximum is the most any one page held at one reading, not a sum across
  pages — `maxInboundAdmissions` and `maxInboundBytes` of its inbound pool (D189), `maxOrderingTracks`
  of the ordering snapshots its inbound stores stated (D191) — and `overloadedReadings` counts the
  readings that found their page refusing its next own send at the count or byte bound. `{ outcome: 'no-readings' }` when no agent read a
  ledger: an artifact from before the block existed, or a cell whose recipes stopped before their
  `stats` step. No threshold reads it, so it fails no cell.
- `congestion` — the congestion decisions the cell's pages counted (D186), from the `rallar.congestion` block of
  each `stats` command's result; the decoded snapshot keeps each reading as `congestionReadings`,
  `{ atEpochMs, agentId, counters }`. A page's counters only grow until its next `close`, so each page contributes its
  largest reading of each count and the cell sums its pages: `{ outcome: 'measured', readingCount, dropped, deferred,
  handedOver }`. The sum is a lower bound for a page that reconnects inside the cell: the counts of its earlier
  connection end at that `close`. A send handed over at admission counts in both `dropped` and `handedOver`.
  `{ outcome: 'no-readings' }` when no agent read the counters: an artifact from before the block existed, not an
  uncongested cell. No threshold reads it.
- `snapshotIssues` — non-empty only when the control snapshot could not be decoded at all.

Every fold reads only the events and results the control server retained for the run. The ALM lane's
scripts set `RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS` and `RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS` to
`unbounded`, so the server keeps the whole run; a control server started without them, or one the lane
reused because it was already running, keeps the defaults.

## Reading a red

> **Classify before judging.** A run is `normal` only when its `regime` and its
> `pageRegime.regime` are both `normal`, and `slow` when either is `slow` — `slow` takes precedence
> over an `unclassified` reading in the other regime, since a slow page or a slow outbound chain is
> still slow regardless of whether the other reading cleared the sample floor. The `rtc` cell's two
> regimes together are the runner's verdict. A red counts only against a green baseline of the
> same carrier and scope whose two regimes match the red's. A red in a slow page regime, compared
> against a normal-page baseline, is a measurement of the runner, not a verdict on the change.
> That holds even when the outbound `regime` of both runs is `normal`: the page regime exists
> because the outbound regime scored `7add928af`'s page `normal`, whose `age-bound` storage-probe
> median ran 141–210 ms over the page window (`ALM_OBSERVATION_WINDOW_MS` to
> `ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event, i.e. 20 s–60 s), beside the
> RTT-off probe's page at 2–4 ms over the same window. Neither regime `slow`, with an `unclassified`
> in either, leaves the cell unattributed. Re-run it once; a repeat `unclassified` is no evidence.

1. Read `regime` and `pageRegime.regime` in the failing cell's file.
2. Find the most recent green run of the same carrier and scope, and read the same two fields.
3. If both cells' `regime` and `pageRegime.regime` are `normal`, the red is a product regression:
   diff the two snapshots.
4. Otherwise, if either of the red's two regimes is `slow` (in the red or in the baseline), the red
   is a measurement of the runner, not a verdict on the change — `slow` takes precedence over an
   `unclassified` reading in the other regime, so this step fires before step 5. Re-run, or compare
   against a green baseline whose two regimes match the red's.
5. Otherwise, if either regime says `unclassified` on either run, the cell carries no regime
   evidence — `perOperation` and `pageRegime`'s `sampleCount` say whether that is too few samples or
   a median inside a band. Re-run once; if it reads `unclassified` again, treat the cell as
   unattributed with no evidence.

**The 2C decision rule reads only a both-`normal` cell.** An outbound `regime` of `slow` or
`unclassified` beside a `normal` `pageRegime.regime` does not decide 2C either way — the rule in the
S2a plan's Task 6 Step 3 applies only when `regime` and `pageRegime.regime` are both `normal`; any
other combination leaves 2C undecided by that cell, under the same precedence as "Classify before
judging" above.

**A baseline recorded before Task 8 carries no `pageRegime`.** Recompute it from its stored
`-snapshot.json` file with the shipped decoder and `computePageRegime`, the way the corpus itself was
read, and mark the recomputed reading as such. Absent that recomputation, such a baseline is compared
on its outbound `regime` alone, which is not a same-regime match under "Classify before judging" and
is marked as an outbound-only comparison.

The band was established on the `rtc` cell. The `ws` and `rtc-with-ws-fallback` cells carry only
4–13 opening-window samples per run, a weaker discriminator than `rtc`'s. Take a run's `rtc` regime
as the runner's verdict, and treat a `normal` regime on a non-`rtc` cell as unattributed rather than
a second confirmation.

Seven hosted observation runs on 2026-09-10/11 put the boundary where the two thresholds sit: every
head whose rtc cell opened at or below 24 ms per operation went 6 ready / 0 timeout, and every head
at or above 36 ms went 0 ready / 6 timeout — including a same-day re-execution of a green head,
which failed identically in the slow regime. The per-run table behind that claim is in the F2 pull
request body (PR #559), under the runner-regime section.

The page thresholds were put the same way, from 24 hosted cells across eight lane runs of the S2
corpus, read as the median `age-bound` probe `durationMs` from `ALM_OBSERVATION_WINDOW_MS` to
`ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event:

| Page | Count | Median band | Cells                                                         |
| ---- | ----- | ----------- | ------------------------------------------------------------- |
| fast | 6     | 1–3 ms      | the RTT-off probe (1 / 3 / 2) and `6f6006cfe` (2 / 1 / 3)     |
| slow | 18    | 66.5–358 ms | every other cell: F 66.5 / 69 / 358, Task 0 113 / 199.5 / 315 |

`ALM_OBSERVATION_NORMAL_PAGE_MAX_PROBE_MS` (20) sits at about 6× the fast band's top;
`ALM_OBSERVATION_SLOW_PAGE_MIN_PROBE_MS` (50) sits below the slow band's lowest cell (66.5 ms).
`ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT` (10) is the sample floor, and
`ALM_OBSERVATION_PAGE_WINDOW_END_MS` (60 000) is where the window closes.

The thresholds — outbound and page alike — are constants, not tuning knobs. Widening them to
absorb a red erases the one signal that separates a slow runner from a regression.
