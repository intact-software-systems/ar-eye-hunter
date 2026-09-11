# ALM Observation Artifact

The ALM conformance lane
(`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`) runs as the Release Gate's
non-blocking `alm-conformance-observation` job. The job uploads the whole Playwright output root,
`apps/rallar-black-box/test-results`, as `alm-conformance-lane-<sha>`.

Every cell — one carrier per cell, pass or fail — writes two files into that root:

| File                                                           | Contents                                    |
| -------------------------------------------------------------- | ------------------------------------------- |
| `test-results/alm-observation/<carrier>-<scope>.json`          | The `ALMObservationRegime` described below. |
| `test-results/alm-observation/<carrier>-<scope>-snapshot.json` | The cell's complete control run snapshot.   |

They live beside the per-test output directories rather than inside one, because Playwright deletes
a passing test's own directory at the end of the run. A failed cell additionally attaches its
snapshot to the Playwright report, which is where it has always been; a green cell used to leave no
evidence at all.

The cell also prints one line to the job log:

```text
ALM observation ws-smoke: regime=normal perOperation=8.67 ms/op over 15 commits outcome=passed
```

## The budgets stay

Maintainer decision, 2026-09-11: the harness budgets are not the thing under test and are not
adjusted to make a run green.

- `CONNECT_READINESS_TIMEOUT_MS` 30 000 — a cold RTC handshake on a fresh server exceeds the message
  deadline, so connect budgets are harness budgets rather than product deadlines.
- The receiver window is derived: `deadlineMs` (18 000 in the lane) plus
  `NON_EXPIRING_SEND_TIMEOUT_MS` for a positive observation, and the bare `deadlineMs` for an
  absence proof.
- `NON_EXPIRING_SEND_TIMEOUT_MS` 10 000 — hosted conformance may need more than five seconds to
  admit a non-expiring send.

All three live in
[`conformance/alm/create-alm-conformance-recipes.ts`](../conformance/alm/create-alm-conformance-recipes.ts).

## The regime file

`ALMObservationRegime`
([`conformance/alm/compute-alm-observation-regime.ts`](../conformance/alm/compute-alm-observation-regime.ts))
records what the runner was doing while the cell ran:

- `regime` — `normal`, `slow`, or `unclassified`.
- `perOperation` — the median admission read cost, `readDurationMs / readOperationCount`, over
  `send`-origin commits inside the opening window, from the `commit-phases` events of the
  [outbound admission diagnostics](./runtime-diagnostic-contract.md). It is `too-few-samples` below
  `ALM_OBSERVATION_MIN_COMMIT_PHASE_COUNT` samples.
- `windowMs` — the opening window the median is taken over, measured from the run's earliest event.
  Only `send`-origin commits count. A failing cell's own degradation dominates a whole-cell median,
  and a drain's commit measures a different read chain than a caller's own admission, so neither
  belongs in a reading of the runner.
- `peerReadiness` — per lifecycle stream and peer, the time from first known to first ready, or
  `never-ready` with how long the peer was observed.
- `scenarioSends` — each recipe run's wall clock, or, for a run that failed, the failing step's
  error code. A failed recipe run carries no result object, so it has no duration to report.
- `workPageRate` — `work-page` storage operations per second between the cell's first and last
  `storage.counters` reading.
- `cellOutcome` — `passed` or `failed`, including a soft-assertion failure.
- `snapshotIssues` — non-empty only when the control snapshot could not be decoded at all.

## Reading a red

A red cell is a regression only when its runner regime matches a green baseline's.

1. Read `regime` in the failing cell's file.
2. Find the most recent green run of the same carrier and scope, and read its `regime`.
3. If both say `normal`, the red is a product regression: diff the two snapshots.
4. If the red says `slow` and the baseline says `normal`, the red is a measurement of the runner,
   not a verdict on the change. Re-run, or compare against a green baseline that also ran `slow`.
5. If either says `unclassified`, the run carries no regime evidence — `perOperation` says whether
   that is too few commit phases or a median inside the band between the thresholds. Treat the cell
   as unattributed and re-run.

The band was established on the `rtc` cell. The `ws` and `rtc-with-ws-fallback` cells carry only
4–13 opening-window samples per run, a weaker discriminator than `rtc`'s. Take a run's `rtc` regime
as the runner's verdict, and treat a `normal` regime on a non-`rtc` cell as unattributed rather than
a second confirmation.

Seven hosted observation runs on 2026-09-10/11 put the boundary where the two thresholds sit: every
head whose rtc cell opened at or below 24 ms per operation went 6 ready / 0 timeout, and every head
at or above 36 ms went 0 ready / 6 timeout — including a same-day re-execution of a green head,
which failed identically in the slow regime. The per-run table behind that claim is in the F2 pull
request body (PR #559), under the runner-regime section.

The thresholds are constants, not tuning knobs. Widening them to absorb a red erases the one signal
that separates a slow runner from a regression.
