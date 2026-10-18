# ALM V1c Artifact Flush Implementation Plan

> Use `superpowers:subagent-driven-development` with a separate implementer and reviewer.

**Goal:** Replace the control artifact recorder's repeated timer loop with the existing shared
flush owner while preserving bounded, complete durable capture.

**Architecture:** `ThrottledFlush` owns scheduling, coalescing and one in-flight flush. The recorder
owns pending rows, overflow, durable receipts and the ordering of writes and deletes. Its read and
shutdown barrier drains the shared flush without preventing later recording. Snapshot persistence
keeps its existing leading-edge behavior.

**Tech stack:** TypeScript, injected `Timers`, Vitest, Deno and real temporary artifact files.

**Spec:** D278 in `playground/alm/alm-v1c-step2-design-proposal.md` and the standing constraints in
`plans/active/alm-v1c-scale-evidence-implementation-plan.md`.

## Global constraints

- No legacy, no duplication, no migration code. Keep the repository consistent and use existing patterns.
- Keep the recorder's 250 ms first-mark batching delay and 160 MiB pending cap unchanged.
- Keep pending rows under the cap while a write stalls; do not materialize an unbounded queue of batches.
- Keep durable receipt certification, paired event/result rows, overflow accounting, run isolation,
  deletion ordering and later recording after a read barrier.
- Every changed human-authored file is reviewed and remediated in full; support files changed by
  remediation enter closure recursively; independent untouched code remains outside closure.
- Do not claim a runtime performance gain from static duplication. Direct timer observations may
  prove removal of idle retry wakeups; full V1c scale and comparative gates remain open.
- The user merges PRs manually. This is the first step 2h increment, not V1c closure.

## Current evidence and choice

Proven from code: `ControlArtifactRecorder.flushTick` re-arms its timer whenever `writing` is true.
The pending rows cannot be written until the current write finishes, so those ticks cannot advance
capture. `stop` cancels the current timer before awaiting writes, but recording during that wait can
arm another timer. `ThrottledFlush` already joins in-flight work and drains marks made during a drain.
Its existing leading-edge timing and terminal `stop` are insufficient for the recorder: add the
explicit delayed-first-mark policy and reusable drain to this owner rather than a second scheduler.

The next two useful increments are this recorder consolidation and the remaining shared-mechanism
audit/next measured repair under step 2h. Checkpoint writing, merged delta design, unused rate
adjustment and V1c acceptance are still open outcomes; this change does not settle them.

## Review focus

- An urgent mark during a slow write must wait for that write, then run without a timing delay.
- Several drain callers must not overlap writes or leave a timer after reaching idle.
- A failed write must settle covered marks and permit later work; drain keeps the existing stop
  failure contract rather than inventing a retry policy.
- A recorder read barrier must preserve rows arriving while it drains and allow subsequent recording.
- Deleting a run while a write is pending or in flight must preserve ordering and other runs' evidence.

### Task 1: Consolidate artifact flush scheduling

**Files:**

- Modify `packages/shared/resilience/throttled-flush.ts` and its mirrored
  `packages/tests/shared/resilience/throttled-flush.test.ts`.
- Modify `apps/rallar-black-box-control-server/src/control-artifact-recorder.ts` and
  `apps/rallar-black-box-control-server/test/control-artifact-recorder.test.ts`.
- Update `apps/rallar-black-box-control-server/src/control-snapshot-persistence.ts` and all other
  verified construction sites for the explicit configuration field.

**Interfaces:**

- Add required `ThrottledFlush.Config.firstMarkDelayMs: number`. For each pending group of marks,
  the ordinary write starts no earlier than its first mark plus this delay and the previous write
  start plus `minIntervalMs`. Later marks join without postponing it. Urgent marks bypass both
  timing limits but never overlap a write. Existing leading-edge users supply zero.
- Add `ThrottledFlush.drain(): Promise<void>`: run scheduled work immediately, join in-flight work,
  include marks made while draining until idle, cancel scheduled work, and remain open for later
  marks. Concurrent drains share the same drain lifecycle. Preserve `stop()` as drain followed by
  terminal refusal. Do not duplicate the drain algorithm.
- The recorder constructs this primitive after its dependencies and storage exist, marks it when
  rows arrive, and drains it at its existing `stop()` read/shutdown barrier. Preserve its existing
  ordered file/delete boundary; do not add a second generic mechanism in the recorder.

- [ ] Write semantic RED cases for delayed first marks, non-postponement, urgent marks, reusable
      and concurrent drain, marks during drain, and failure recovery. Run
      `npx vitest run packages/tests/shared/resilience/throttled-flush.test.ts` and record the expected
      pre-implementation failures.
- [ ] Implement the shared policy and drain; update all construction sites explicitly. Run the
      focused suite GREEN. Keep zero-delay snapshot behavior covered by its existing Deno suite.
- [ ] At the recorder boundary, prove a stalled disk has no periodic retry timers, and a drain
      includes rows arriving during its wait without a residual timer; verify later recording and
      deletion isolation against real files. Observe RED before replacing its scheduler.
- [ ] Compose the shared flush and remove the recorder's duplicate scheduling state and methods.
      Preserve the disk ordering boundary and capture-failure semantics. Run recorder/capture tests GREEN.
- [ ] Run `npx tsc -p packages/shared/tsconfig.json --noEmit`; from the control-server directory run
      `deno task check` and `deno test --allow-run --allow-net --allow-env --allow-read --allow-write
  test/control-artifact-recorder.test.ts test/control-result-release.test.ts
  test/control-result-release-api.test.ts test/control-snapshot-persistence.test.ts`.
- [ ] Review the complete changed files, trace construction and timer/drain invocation, and run
      repo style, structure and legacy checks. Commit the coherent code/tests on this feature branch.

## Delivery

Keep the PR draft while validation or review remains incomplete. Explain the changed scheduling,
preserved capture contract and remaining V1c work in its semantic body. Delete this narrow plan
in the PR once this increment is complete; keep the parent V1c plan until its full acceptance is
proved. Run delivery readiness once at the final handoff and wait for the user's manual merge.
