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
ALM observation ws-smoke: regime=normal perOperation=8.67 ms/op over 15 commits outcome=passed page=normal (2 ms/probe over 34)
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
- `pageRegime` — the page's storage queue, beside `regime`'s admission chain. It is the median
  `durationMs` of the outbound `age-bound` `readiness-probe` events, over both roles, from
  `ALM_OBSERVATION_WINDOW_MS` to `ALM_OBSERVATION_PAGE_WINDOW_END_MS` after the run's first event: an
  `age-bound` probe is a fixed-shape storage read taken only because the remembered answer aged out,
  so its duration reads how long the read queued behind the page's other IndexedDB transactions
  rather than anything about the admission chain itself. The window is deferred past the outbound
  regime's own opening window because page start-up contends too. `{ outcome: 'unmeasured',
  sampleCount, regime: 'unclassified' }` below `ALM_OBSERVATION_MIN_STORAGE_PROBE_COUNT` samples;
  otherwise `{ outcome: 'measured', storageProbeMedianMs, sampleCount, regime }`.
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
  for one that carried none of the three kinds. The decoded snapshot keeps each `admission-outcome`'s
  `msgId`, `carrier` and `reason` beside its `outcome`, so one message arriving over both carriers
  reads as two outcomes for one `msgId`. In the `cross-carrier-duplicate` scenario, both orders show
  one `committed`/`admitted` and one `not-handled`/`duplicate` for the pair's `msgId`; in
  `rtc-then-ws` the refused copy is the one on carrier `ws`. In `not-yet-in-sync`, the receiver's
  refusal reads `rejected` over `rtc` with a reason starting `not-yet-in-sync`;
  `delivered-after-refresh` reads red at `received-1`, because no plain-member write advances the
  snapshot version. A measured direction carries:
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
