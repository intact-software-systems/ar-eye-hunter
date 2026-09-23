# ALM Observation Artifact

The ALM conformance lane
(`tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`) runs as the Release Gate's
non-blocking `alm-conformance-observation` job. The job uploads the whole Playwright output root,
`apps/rallar-black-box/test-results`, as `alm-conformance-lane-<sha>`.

Every cell — one carrier per cell, pass or fail — writes these files into that root:

| File                                                                   | Contents                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `test-results/alm-observation/<carrier>-<scope>.json`                  | The `ALMObservationRegime` described below.                  |
| `test-results/alm-observation/<carrier>-<scope>-snapshot.json`         | The cell's complete control run snapshot.                    |
| `test-results/alm-observation/<carrier>-<scope>-page-diagnostics.json` | The lane's raw `pageerror`/console capture (Task 7b, below). |

They live beside the per-test output directories rather than inside one, because Playwright deletes
a passing test's own directory at the end of the run. A failed cell additionally attaches its
snapshot to the Playwright report, which is where it has always been; a green cell used to leave no
evidence at all. The page-diagnostics file is written only when at least one agent page attached a
capture; every real lane run does, so its absence marks an artifact from before Task 7b.

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
- `inbound` — one entry per direction (`sender`, `receiver`, `unattributed`), from the
  `admission-outcome`, `effect-drain` and `claim-settled` events of the
  [inbound admission diagnostics](./runtime-diagnostic-contract.md). The direction is resolved from
  the lane's `alm-<role>` agent id prefix; any other id is `unattributed` rather than guessed. `[]`
  when the cell carried no inbound event at all; otherwise every direction is reported, `no-events`
  for one that carried none of the three kinds. A measured direction carries:
  - `pendingShare` — `{ outcome: 'measured', pendingSharePercent, outcomeCount }`, the share of
    `admission-outcome` events on that direction whose outcome was `pending`, out of `outcomeCount`;
    or `{ outcome: 'unmeasured' }` when the direction reported `effect-drain` events but no
    `admission-outcome` event, because a percentage over zero outcomes is not a measurement. The
    drain medians beside it are still reported in that case.
  - `phases` — the median of each `effect-drain` phase (`selectionMedianMs`, `claimMedianMs`,
    `runMedianMs`, `releaseMedianMs`, `queueWaitMedianMs`) and of `durationMs` itself
    (`drainMedianMs`), over `drainCount` drains. Unlike `perOperation`, these medians are taken over
    the whole cell, not the opening window, because this block reads the receiver rather than the
    runner. `drainCount: 0` with every median at `0` means the direction reported admission outcomes
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
    `durationMs` of the `send-control` claims, over `sendControlClaimCount`. Whole-cell medians, like
    `phases`; every figure is `0` with a count of `0` when the direction ran no such claim, and a
    `claim-settled` event missing `durationMs`, `dueAtMs`, `batchStartedAtMs` or `startedAtMs` (one
    emitted before the three instants existed) is skipped rather than counted. `dueAtMs` is read from
    the reserved entry, and a reservation clears a retried row's retry stamp, so a claim of a row that
    had been retried reports its wait from when the row was written, not from its latest retry due
    time; a `reservationWaitMedianMs` over retried rows is an upper bound.
- `cellOutcome` — `passed` or `failed`, including a soft-assertion failure.
- `pageDiagnostics` — the lane's `pageerror`/console capture, folded from the cell's
  `-page-diagnostics.json` file. It captures page-level errors only and does not by itself prove
  where a frame was lost; it names the page it happened on, and where in the cell's timeline, for the
  next hosted red to correlate against the control snapshot's own events. `{ outcome: 'not-captured' }`
  when the lane did not supply the file at all — an artifact from before Task 7b, not a page that
  raised nothing. Otherwise `{ outcome: 'captured', counts, dropped, first }`: `counts` is the number
  of `pageerror`, `console-error` (`consoleError`) and `console-warning` (`consoleWarning`) records;
  `dropped` is how many more the lane's 200-per-page cap discarded; `first` is the earliest 20 records
  across both agent pages, each `{ agentId, role, atMs, kind, message, stack? }` with `atMs` relative
  to the cell's first control event when the snapshot decoded, else the earlier page's own creation.
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
