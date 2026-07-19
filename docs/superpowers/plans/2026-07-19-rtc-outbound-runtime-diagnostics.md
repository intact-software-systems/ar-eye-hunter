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

- [ ] **Step 5: Push and collect iteration 5**

Push the correction to PR #40, rerun the unchanged 15-agent manifest, and
compare topology churn, RTC reschedules, sender-queue wait, frame latency, and
the recipe conclusion against iteration 4.

## Self-review

- Spec coverage: instrumentation, unchanged workload, GitHub artifact analysis,
  correlation, and same-PR publication are each assigned to a task.
- Placeholder scan: no implementation step uses TBD/TODO or an unspecified
  behavior.
- Type consistency: `ALOutboundRuntimeDiagnosticsSink`,
  `RallarOperationOptions.outboundDiagnostics`, and
  `rallar.browser.al.outbound_runtime` are named consistently across tasks.
