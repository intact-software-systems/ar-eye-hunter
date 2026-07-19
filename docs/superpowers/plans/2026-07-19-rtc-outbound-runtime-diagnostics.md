# RTC Outbound Runtime Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correlate slow black-box RTC stream frames with the browser outbound
sender queue, cross-context lock, and durable-effect drain boundaries before
making another performance correction.

**Architecture:** Enrich the existing `ALOutboundMessageRuntime` diagnostics
with a mandatory runtime label and message identities, preserve the optional
sink through `rallar.connect(...)`, and adapt that sink into the existing
black-box browser event stream. The unchanged 15-agent recipe will then provide
the runtime evidence needed to confirm or falsify the local outbound contention
hypothesis.

**Tech Stack:** TypeScript, Vitest, Rallar shared/shared-web/shared-test
packages, GitHub Actions distributed black-box runner.

## Global Constraints

- Count the three completed remote reruns as iterations 1-3 and stop no later
  than iteration 10.
- Keep the manifest, 5 Hz rate, 150-frame count, thresholds, topology, and
  delivery semantics unchanged.
- Do not optimize the outbound path until iteration-4 artifacts identify the
  dominant measured boundary.
- Push every commit and rerun from
  `codex/rtc-signaling-boundary-diagnostics` / PR #40.
- Generated runtime artifacts stay outside the repository or under ignored
  `tmp/perf/` paths.

---

### Task 1: Correlate AL outbound runtime diagnostics

**Files:**

- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- Modify: `packages/shared/services/WsQueueBoxClientService.ts`
- Modify: `packages/shared/services/WsQueueBoxServerService.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`

**Interfaces:**

- Consumes: existing optional `ALOutboundRuntimeDiagnosticsSink`.
- Produces: diagnostics with mandatory `runtime`, per-operation `message`, and
  effect-drain `messages` correlation fields.

- [x] **Step 1: Write the failing correlation assertions**

Extend the diagnostics test so the emitted sender/lock events contain:

```ts
{
    runtime: 'test-outbound',
    message: {
        msgId: message.id.msgId,
        senderId: 'self',
        resourceId: 'msg-diagnostics',
    },
}
```

and the `effect-drain` event contains the same message in `messages`.

- [x] **Step 2: Run the test and verify RED**

Run:

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected: FAIL because diagnostics do not yet contain `runtime`, `message`, or
`messages`.

- [x] **Step 3: Add the minimal diagnostic context**

Add a required input label and message summary:

```ts
export type ALOutboundRuntimeMessageDiagnostics = Readonly<{
  msgId: string;
  senderId: string;
  resourceId: string;
}>;

export type ALOutboundMessageRuntimeInput<TPrepared> = Readonly<{
  diagnosticsRuntime: string;
  // existing fields remain unchanged
}>;
```

Every diagnostic event includes `runtime`. Sender-queue and browser-lock events
include the current message summary. Effect drains collect unique summaries
from claimed effects only when a diagnostics sink is installed. Configure the
three production runtime owners with `rtc-overlay`, `ws-client`, and
`ws-server` labels.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command. Expected: PASS with no warnings.

- [x] **Step 5: Commit the self-contained shared-runtime change**

```sh
git add packages/shared/alm/ALOutboundMessageRuntime.ts \
  packages/shared/multicast/WebRtcOverlayMulticastManager.ts \
  packages/shared/services/WsQueueBoxClientService.ts \
  packages/shared/services/WsQueueBoxServerService.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts
git commit -m "feat: correlate outbound runtime diagnostics"
```

### Task 2: Publish outbound timings through the black-box browser

**Files:**

- Modify: `packages/shared-web/browser/rallar-operation-options.ts`
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/runtime.ts`
- Test: `packages/tests/shared-web/rallar-operation-options.test.ts`
- Test: `packages/tests/shared-test/rallar-browser-runtime.test.ts`

**Interfaces:**

- Consumes: `ALOutboundRuntimeDiagnosticsSink` and the enriched events from
  Task 1.
- Produces: `rallar.browser.al.outbound_runtime` black-box diagnostic events.

- [x] **Step 1: Write failing option-normalization and browser-event tests**

The operation-options test supplies a sink and expects
`toRallarOperationOptions(...)` to preserve it. The black-box runtime test
captures the options passed to `rallar.connect`, invokes
`outboundDiagnostics(...)` with a correlated `rtc-overlay` event, and expects a
published event shaped like:

```ts
{
    kind: 'diagnostic',
    topic: 'rallar.browser.al.outbound_runtime',
    connection: 'aliceRtc',
    data: expect.objectContaining({
        kind: 'sender-queue-wait',
        runtime: 'rtc-overlay',
        message: expect.objectContaining({ resourceId: 'frame-resource-1' }),
    }),
}
```

- [x] **Step 2: Run the tests and verify RED**

Run:

```sh
npx vitest run \
  packages/tests/shared-web/rallar-operation-options.test.ts \
  packages/tests/shared-test/rallar-browser-runtime.test.ts
```

Expected: FAIL because the option is discarded and the black-box runtime does
not install a sink.

- [x] **Step 3: Preserve and adapt the optional sink**

Add this field to `RallarOperationOptions` and its normalization path:

```ts
outboundDiagnostics?: ALOutboundRuntimeDiagnosticsSink;
```

Pass this callback from the black-box connect call:

```ts
outboundDiagnostics: event =>
    emitDiagnostic(
        config,
        'rallar.browser.al.outbound_runtime',
        event,
    ),
```

- [x] **Step 4: Run the Task 2 tests and verify GREEN**

Run the Task 2 command. Expected: PASS with no warnings.

- [x] **Step 5: Commit the browser adapter change**

```sh
git add packages/shared-web/browser/rallar-operation-options.ts \
  packages/shared-test/black-box-runner/browser/rallar-browser-runtime/runtime.ts \
  packages/tests/shared-web/rallar-operation-options.test.ts \
  packages/tests/shared-test/rallar-browser-runtime.test.ts
git commit -m "feat: export outbound timings in black-box runs"
```

### Task 3: Validate, publish, and collect iteration 4

**Files:**

- Modify: `docs/superpowers/specs/2026-07-19-rtc-topology-fallback-precedence-remediation-design.md`

**Interfaces:**

- Consumes: the unchanged Hetzner manifest and enriched browser diagnostics.
- Produces: iteration-4 GitHub artifacts and an evidence-backed next action.

- [x] **Step 1: Run focused regression tests and typechecks**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared-web/rallar-operation-options.test.ts \
  packages/tests/shared-test/rallar-browser-runtime.test.ts \
  packages/tests/shared-web/browser-middleware-rtt.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npm run typecheck --workspace @ar-eye-hunter/shared-web
npm run typecheck --workspace @ar-eye-hunter/shared-server
```

Expected: all commands exit 0.

- [x] **Step 2: Push both commits to PR #40**

```sh
git push origin codex/rtc-signaling-boundary-diagnostics
```

- [x] **Step 3: Dispatch iteration 4 with the unchanged manifest**

Use the same workflow inputs as iteration 3, changing only unique run/control
identifiers and the selected branch SHA. The manifest remains:

```text
apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json
```

- [x] **Step 4: Download and analyze GitHub artifacts**

Read `analysis.json`, `fix-proposal.md`, `performance.md`, `results.jsonl`, and
`events.jsonl`. For each stream frame, correlate the completed message with
`rtc-overlay` outbound events and compare frame duration against:

- sender queue wait;
- browser lock wait and hold;
- effect-drain duration and batch membership.

Confirmation signal: one boundary explains the slow completion batches and
crosses the configured p95/p99 thresholds. Falsification signal: all recorded
outbound boundaries remain short while the stream frame duration remains long.

- [x] **Step 5: Record the measured result before any correction**

Append the GitHub run ID, commit SHA, exact metrics, confirmed/refuted
hypotheses, and next minimal fix area to the remediation design document. Commit
and push the evidence to PR #40.

### Task 4: Coalesce RTT work behind reserved topology recomputes

**Files:**

- Modify: `packages/shared-server/rallar-system/services/RtcTopologyOutboxWork.ts`
- Test: `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`

**Interfaces:**

- Consumes: immutable reserved `APP_OUTBOX` topology work generations.
- Produces: at most one coalescing successor per reserved generation, with a
  bounded successor chain when a worker has already reserved that successor.

- [x] **Step 1: Reproduce the unique-successor fanout**

Add a test that reserves one RTT recompute, publishes two newer RTT updates,
and expects both updates to merge into one successor. Verify RED because the
peer-pair/version resource IDs create two successors.

- [x] **Step 2: Coalesce by reserved resource and generation**

Derive the successor key from the blocked resource ID and immutable generation.
If that successor is already reserved, continue through a bounded successor
chain rather than dropping the new RTT update.

- [x] **Step 3: Cover the reserved-successor race**

Reserve the first successor, publish another RTT update, and verify a further
drainable successor retains the newest version and request time.

- [x] **Step 4: Run focused topology regressions and typecheck**

```sh
npx vitest run \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/coalesced-app-outbox-work-service.test.ts \
  packages/tests/shared-server/rallar-rtc-topology-service.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
npm run typecheck --workspace @ar-eye-hunter/shared-server
```

- [x] **Step 5: Push and collect iteration 5**

Push the correction to PR #40, rerun the unchanged 15-agent manifest, and
compare topology churn, RTC reschedules, sender-queue wait, frame latency, and
the recipe conclusion against iteration 4.

### Task 5: Honor durable-effect retry boundaries

**Files:**

- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`

**Interfaces:**

- Consumes: `ALOutboundPreparedSendResult.status === 'not-ready'` and its
  `retryAfterMs` boundary.
- Produces: one drain batch per retry cycle when any claimed effect is
  rescheduled; the scheduled next drain owns the retry.

- [x] **Step 1: Reproduce same-drain retry amplification**

Use fake timers and a prepared sender that returns `not-ready` once with a
zero-delay retry. Verify RED because the current drain immediately reclaims the
effect and invokes the sender twice before the first enqueue resolves.

- [x] **Step 2: Yield after a rescheduled batch**

Track whether any effect in the claimed batch is rescheduled, including error
reschedules. Finish the current drain after the batch so
`scheduleEffectDrainAt(...)` controls the next claim.

- [x] **Step 3: Verify retry timing and focused regressions**

The enqueue must observe one attempt; advancing the scheduled timer must
observe the second attempt. Run the outbound runtime, RTC overlay, multicast
policy, operation-options, browser-runtime, and middleware regressions plus
the shared/shared-web/shared-server/shared-test checks.

- [x] **Step 4: Push and collect iteration 6**

Rerun the unchanged 15-agent manifest and require a material reduction in the
claimed-to-completed amplification and effect-drain/sender-queue tails before
accepting the correction.

### Task 6: Preserve fresh-effect progress under retry backlog

**Files:**

- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`

**Interfaces:**

- Consumes: ready durable effects split by `attempts === 0` and
  `attempts > 0`.
- Produces: a 16-effect claim with up to 12 fresh effects and at least 4 ready
  retries when both classes are backlogged; unused capacity is filled by the
  other class.

- [x] **Step 1: Reproduce first-attempt starvation**

Persist and reschedule 16 retry effects, then persist 16 fresh effects at the
same ready time. Verify RED because retry-time/effect-ID ordering fills the next
claim entirely with retries.

- [x] **Step 2: Reserve bounded capacity for both classes**

Select ready effects with three quarters of a mixed claim reserved for fresh
first attempts and one quarter reserved for retries. Preserve retry-time and
effect-ID ordering within each class and fill any unused quota from the other
class.

- [x] **Step 3: Verify focused regressions and typechecks**

Run the outbound runtime/store tests, RTC overlay and multicast regressions,
and the shared/shared-web/shared-server/shared-test checks.

- [x] **Step 4: Push and collect iteration 7**

Rerun the unchanged 15-agent manifest. Acceptance requires a material reduction
in stream-message first-drain delay and p95/p99 frame latency without restoring
same-drain retry amplification or causing drops.

Iteration 7 failed this acceptance criterion. Revert the mixed-claim quota in
the next correction rather than combining it with another unmeasured change.

### Task 7: Settle each claimed effect batch atomically

**Files:**

- Modify: `packages/shared/alm/ALOutboundAdmissionStore.ts`
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`
- Test: `packages/tests/shared/al-indexeddb-runtime-stores.test.ts`

**Interfaces:**

- Consumes: the completed/rescheduled outcomes for one claimed drain batch.
- Produces: optional `settleClaimedEffects(...)`, which verifies lease
  ownership and applies all outcomes through one admission-backend write
  boundary; custom stores without it retain the per-effect fallback.

- [x] **Step 1: Reproduce the missing batch settlement boundary**

Claim one completed and one retryable durable effect, then require one API call
to remove the completed effect and make only the retryable effect claimable.
Verify RED because the admission store only exposes per-effect settlement.

- [x] **Step 2: Batch store settlement and runtime use**

Add the claimed-batch settlement contract, implement it as one backend write,
and make `completeEffect(...)` / `rescheduleEffect(...)` compatible delegates.
Accumulate outcomes while running the claimed batch, then settle once. If the
atomic write fails, conservatively convert completed outcomes to retries so
the existing at-least-once recovery behavior remains intact.

- [x] **Step 3: Verify focused regressions and typechecks**

Run outbound runtime and IndexedDB persistence tests, the RTC/browser regression
surface, and shared/shared-web/shared-server/shared-test checks.

- [x] **Step 4: Push and collect iteration 8**

Rerun the unchanged 15-agent manifest after reverting iteration 7's rejected
claim quota. Acceptance requires lower drain milliseconds per claimed effect,
lower first-matching-drain delay, and lower frame p95/p99 without drops.

Iteration 8 accepted the storage primitive but failed the end-to-end acceptance
criterion. Batch settlement reduced drain duration per claim from 25 ms to 18
ms on average and drain p95 from 247 ms to 128 ms, but increased available retry
capacity exposed a fixed-delay retry storm: 51,354 effects were claimed, 3,026
completed, and 48,301 rescheduled. Stream latency regressed to p50 2,273 ms,
p95 10,001 ms, and p99 12,602 ms.

### Task 8: Let durable RTC sends use exponential retry backoff

**Files:**

- Modify: `packages/shared/multicast/WebRtcOverlayMulticastManager.ts`
- Test: `packages/tests/shared/webrtc-overlay-services.test.ts`

**Interfaces:**

- Consumes: a missing or non-open RTC data channel while running a durable
  `send-prepared` effect.
- Produces: `status: 'not-ready'` without a transport-specific fixed delay, so
  `ALOutboundMessageRuntime` applies its existing bounded exponential delay.

- [x] **Step 1: Reproduce the fixed-delay retry loop**

Keep a durable channel unavailable through the first retry, make it available,
and assert that the next attempt waits 100 ms rather than repeating after 50
ms. Verify RED because the RTC manager currently supplies `retryAfterMs: 50` on
every attempt.

- [x] **Step 2: Restore the runtime-owned retry policy**

Remove the 50 ms override from both missing-channel and non-open-channel
results. Preserve `not-ready`, the reason, persistence, and the existing 5 s
runtime backoff cap.

- [x] **Step 3: Verify focused regressions and typechecks**

Run the RTC overlay, outbound runtime, IndexedDB, multicast, browser runtime,
and middleware regressions plus shared/shared-web/shared-server/shared-test
checks.

- [x] **Step 4: Push and collect iteration 9**

Rerun the unchanged 15-agent manifest. Acceptance requires a material drop in
claimed/rescheduled effects and first-matching-drain delay, with all streams
meeting the unchanged success and latency thresholds.

Iteration 9 accepted the exponential retry correction but did not meet the
end-to-end latency gate. Claims fell from 51,354 to 10,520 and reschedules from
48,301 to 6,000. Stream latency improved to p50 594 ms / p95 6,012 ms / p99
9,038 ms, with 124 failures and no drops. The remaining delay correlated at
0.980 with overlapping drain time; 48 completed sends had no matching own drain,
showing that the synchronous wait was coupled to unrelated work rather than
guaranteeing its committed effect ran.

### Task 9: Decouple persisted enqueue completion from an active drain

**Files:**

- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts`

**Interfaces:**

- Consumes: a successfully committed `status: 'enqueued'` bundle while another
  durable-effect drain is active.
- Produces: immediate completion from the durable admission commit while the
  active/background drain retains ownership of materializing the outbox effect.
  Immediate prepared sends keep their synchronous transport completion.

- [x] **Step 1: Reproduce the unrelated-drain wait**

Block an immediate prepared send, commit a second persistent enqueue, and
assert that the persistent result settles before the unrelated send is
released. Verify RED because `finalizeCommittedOutbound(...)` awaits the active
drain before returning.

- [x] **Step 2: Return persisted commits while an active drain owns progress**

When the committed result is `enqueued` and a drain promise already exists,
request background progress and return the computed result. Preserve the
existing awaited path when no drain is active and for all immediate prepared
sends.

- [x] **Step 3: Verify focused regressions and typechecks**

Run the outbound runtime, IndexedDB, RTC overlay, multicast, operation-options,
browser runtime, and middleware tests plus shared/shared-web/shared-server and
shared-test TypeScript+Deno checks.

- [ ] **Step 4: Push and collect iteration 10**

Run the unchanged manifest for the tenth and final iteration. Record the
terminal recipe result and all outbound/stream metrics; do not make a further
correction in this investigation if the gate still fails.

## Self-review

- Spec coverage: instrumentation, unchanged workload, GitHub artifact analysis,
  correlation, and same-PR publication are each assigned to a task.
- Placeholder scan: no implementation step uses TBD/TODO or an unspecified
  behavior.
- Type consistency: `ALOutboundRuntimeDiagnosticsSink`,
  `RallarOperationOptions.outboundDiagnostics`, and
  `rallar.browser.al.outbound_runtime` are named consistently across tasks.
