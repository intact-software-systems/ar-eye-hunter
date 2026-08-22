# Rallar Black Box RTC Realtime Stream Durable Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace high-rate realtime Hetzner recipes that currently execute hundreds of sequential `rtc.send` commands with one bounded streaming RTC command that preserves 20 Hz pacing, returns aggregate RTT/send metrics, and gives the analyzer and SPA truthful pass/fail/performance evidence.

**Architecture:** Add an opt-in shared-test command, `rtc.stream`, beside the existing `rtc.connect` and `rtc.send` contracts. The browser adapter owns high-rate scheduling and sends frames without waiting for each frame before scheduling the next one; shared analysis and the SPA consume the resulting stream summary and JSONL events. Existing single-send recipes stay compatible, while Hetzner realtime manifests switch to the streaming primitive first.

**Tech Stack:** TypeScript, Vitest, `packages/shared-test/rallar-bb-test`, Rallar black-box browser adapter, Vite/React SPA, Hetzner distributed recipe GitHub Action, generated JSON manifests.

---

Date: 2026-06-27

Status: Ready for implementation.

## Evidence Driving This Plan

Remote run `28291384177` used `apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json` on `main`.

- Rollout succeeded.
- Both agents registered.
- `rtc.connect.readiness` passed.
- RTC messages moved between agents.
- The run timed out because both top-level `recipe.run` commands remained pending.
- `events.jsonl` showed 200 `rtc.send` starts, 199 completions, and 198 received RTC messages.
- Raw `rtc.send` durations were roughly p50 `2113ms`, p95 `3152ms`, p99 `3553ms`, max `3717ms`.
- The recipe intended 100 frames over 5 seconds, but `loop` currently awaits every child command. The command workload therefore behaves like a multi-minute sequential command run, not a realtime 20 Hz stream.

## End State

- `05-rtc-realtime-2-agent-5s.json` finishes in one remote run without increasing the terminal timeout as the primary fix.
- `06-rtc-realtime-3-agent-15s.json` produces a three-agent load baseline with stream percentiles and frame delivery counts.
- The SPA import panel shows stream health: planned frames, attempted frames, completed sends, failures, dropped/backpressured frames, p50/p95/p99/max send duration, achieved Hz, and slowest agents.
- The analyzer no longer reports “Run ended without linked failure evidence” when JSONL contains clear stream or in-flight command evidence.
- Existing `rtc.send`, `loop`, provider parity, smoke, and local fixture behavior remain compatible unless a recipe explicitly opts into `rtc.stream`.

## Non-Goals

- Do not change global `loop` semantics. `loop` remains sequential and useful for deterministic command workflows.
- Do not make every RTC recipe use streaming. Smoke and provider parity recipes can stay command-oriented unless evidence shows they need a streaming primitive.
- Do not hide poor runtime performance by only raising GitHub Action timeouts. Timeout tuning is allowed for remote verification, but it is not the durable fix.
- Do not move unrelated app-local UI code into `packages/shared-test` as part of this plan.

## Files By Responsibility

Create:

- `packages/shared-test/rallar-bb-test/rtc-stream.ts`: pure stream plan, placeholder replacement, metric aggregation, percentile, threshold, and result helpers.
- `packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`: pure helper tests for planning, pacing, aggregation, thresholds, and placeholder replacement.

Modify:

- `packages/shared-test/rallar-bb-test/types.ts`: add `rtc.stream` command, stream options, frame observation, summary, threshold, and result value types.
- `packages/shared-test/rallar-bb-test/schema.ts`: add JSON schema, capability docs, examples, and schema compatibility corpus entries for `rtc.stream`.
- `packages/shared-test/rallar-bb-test/control-protocol.ts`: ensure control command validation accepts and rejects `rtc.stream` consistently with shared schema.
- `packages/shared-test/rallar-bb-test/browser-adapter.ts`: execute `rtc.stream` in the browser adapter using a paced non-sequential scheduler.
- `packages/shared-test/rallar-bb-test/runtime.ts`: include `rtc.stream` in command history, stats summaries, and fallback fake results only where the current runtime already handles external browser commands.
- `packages/shared-test/rallar-bb-test/recipe-fixtures.ts`: add an execution-mode option to `createRallarBlackBoxRtcRealtimeRecipe` and generate `rtc.stream` when requested.
- `packages/shared-test/rallar-bb-test/mod.ts`: export the stream helper/types if they are useful outside the package.
- `apps/rallar-black-box/src/distributed-recipes.ts`: show stream command previews and add preflight warnings for high-rate looped `rtc.send`.
- `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`: switch the two realtime Hetzner manifests to streaming mode.
- `apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`: no behavior change expected, but regenerate and check deterministic output.
- `apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json`: regenerated with `rtc.stream`.
- `apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json`: regenerated with `rtc.stream`.
- `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`: derive stream metrics and timeout evidence from `results.jsonl` and `events.jsonl`.
- `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts`: keep compatibility exports aligned with shared analysis.
- `apps/rallar-black-box/src/rtc-diagnostics.ts`: render stream performance details in imported artifacts and run panels.
- `apps/rallar-black-box/src/App.tsx`: expose the new stream metrics in the imported distributed artifact UI.
- `packages/tests/shared-test/rallar-bb-test-schema.test.ts`: schema validation for `rtc.stream`.
- `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`: control protocol validation for `rtc.stream`.
- `packages/tests/shared-test/rallar-bb-test.test.ts`: browser adapter runtime execution coverage for `rtc.stream`.
- `packages/tests/rallar-black-box/distributed-recipes.test.ts`: recipe builder and preflight coverage.
- `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`: generated manifest and live manifest policy coverage.
- `packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts`: stream metric and timeout evidence coverage.
- `packages/tests/rallar-black-box/distributed-artifact-spa.test.ts`: imported artifact UI model coverage.
- `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`: document command shape and result contract.
- `docs/rallar-hetzner-distributed-recipes.md`: document the realtime stream manifests and expected analysis output.
- `skills/rallar-hetzner-ops/references/performance-thresholds.md`: update operator reporting expectations for stream runs.

## Command Contract

Add this command kind:

```ts
export type RallarBlackBoxTestRtcStreamCommand =
    & RallarBlackBoxTestCommandBase<'rtc.stream'>
    & Readonly<{
        connection?: string;
        actor?: string;
        roomId?: string;
        applicationId?: string;
        workspaceId?: string;
        scope?: Readonly<Record<string, unknown>>;
        roomRef?: Readonly<Record<string, unknown>>;
        transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
        send: unknown;
        count?: number;
        durationMs?: number;
        intervalMs?: number;
        rateHz?: number;
        maxInFlight?: number;
        drainTimeoutMs?: number;
        continueOnSendFailure?: boolean;
        progressEveryMs?: number;
        sampleEvery?: number;
        thresholds?: RallarBlackBoxTestRtcStreamThresholds;
    }>;
```

Semantics:

- `count` or `durationMs` must be present.
- `intervalMs` or `rateHz` must be present.
- If both `count` and `durationMs` are present, the stream stops when the first bound is reached.
- Frames are scheduled from a fixed wall-clock start: `scheduledAtEpochMs = startedAtEpochMs + index * intervalMs`.
- Scheduling never waits for the previous send to complete.
- `maxInFlight` defaults to `64`; exceeding it records a dropped frame and continues unless `continueOnSendFailure === false` and thresholds fail at the end.
- `drainTimeoutMs` defaults to `5000`; after scheduling stops, the command waits for in-flight sends until the drain deadline.
- `sampleEvery` defaults to `1` for tests and short Hetzner manifests. It can be raised later for long soak runs.
- Placeholders available inside `send` are `{stream.index}`, `{stream.iteration}`, `{stream.elapsedMs}`, `{stream.scheduledElapsedMs}`, and `{stream.commandId}`.
- The browser adapter emits `rallar.bb.rtc.stream_started`, `rallar.bb.rtc.stream_progress`, and `rallar.bb.rtc.stream_completed` or `rallar.bb.rtc.stream_failed`.

Result value:

```ts
export type RallarBlackBoxTestRtcStreamResultValue = Readonly<{
    commandId: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    plannedFrames: number;
    scheduledFrames: number;
    attemptedFrames: number;
    completedFrames: number;
    failedFrames: number;
    droppedFrames: number;
    backpressureCount: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    elapsedMs: number;
    requestedRateHz?: number;
    achievedScheduleHz?: number;
    achievedCompletionHz?: number;
    pacing: Readonly<{
        intervalMs: number;
        maxStartDriftMs?: number;
        averageStartDriftMs?: number;
        maxJitterMs?: number;
        lateFrameCount: number;
    }>;
    duration: Readonly<{
        minMs?: number;
        p50Ms?: number;
        p95Ms?: number;
        p99Ms?: number;
        maxMs?: number;
        averageMs?: number;
    }>;
    thresholdFailures: readonly RallarBlackBoxTestRtcStreamThresholdFailure[];
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
}>;
```

## Iteration 1: Shared Contract And Schema

Goal: make `rtc.stream` a validated shared-test command before any runtime behavior exists.

### Files

- Modify: `packages/shared-test/rallar-bb-test/types.ts`
- Modify: `packages/shared-test/rallar-bb-test/schema.ts`
- Modify: `packages/shared-test/rallar-bb-test/control-protocol.ts`
- Modify: `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`
- Test: `packages/tests/shared-test/rallar-bb-test-schema.test.ts`
- Test: `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`

### Steps

- [ ] **Step 1: Add failing schema tests**

Add tests that accept this command:

```ts
{
    kind: 'rtc.stream',
    commandId: 'stream-position',
    connection: 'rtcRealtime',
    transport: 'realtime',
    roomId: 'arena-1',
    applicationId: 'rallar-server',
    workspaceId: 'default',
    count: 100,
    intervalMs: 50,
    maxInFlight: 64,
    drainTimeoutMs: 5000,
    send: {
        roomId: 'arena-1',
        data: {
            topic: 'room.black-box.rtc-realtime.position',
            seq: '{stream.index}',
            frame: '{stream.iteration}',
            tMs: '{stream.elapsedMs}',
        },
    },
    thresholds: {
        minSendSuccessRatio: 0.99,
        maxDroppedFrames: 0,
    },
}
```

Add rejection assertions for:

- `count: 0`
- `durationMs: 0`
- `intervalMs: 0`
- `rateHz: 0`
- `maxInFlight: 0`
- missing both `count` and `durationMs`
- missing both `intervalMs` and `rateHz`
- `thresholds.minSendSuccessRatio: 1.2`

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
```

Expected: FAIL because `rtc.stream` is not a known command kind.

- [ ] **Step 2: Add the command types**

Update `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` and the command union in `packages/shared-test/rallar-bb-test/types.ts`. Add these exported types:

```ts
export type RallarBlackBoxTestRtcStreamThresholds = Readonly<{
    minSendSuccessRatio?: number;
    maxDroppedFrames?: number;
    maxBackpressureCount?: number;
    maxP95SendDurationMs?: number;
    maxP99SendDurationMs?: number;
    maxAverageStartDriftMs?: number;
    maxStartDriftMs?: number;
    maxJitterMs?: number;
}>;

export type RallarBlackBoxTestRtcStreamFrameObservation = Readonly<{
    index: number;
    iteration: number;
    commandId: string;
    scheduledAtEpochMs: number;
    startedAtEpochMs?: number;
    completedAtEpochMs?: number;
    startDriftMs?: number;
    durationMs?: number;
    ok: boolean;
    dropped?: boolean;
    backpressured?: boolean;
    status?: string;
    errorCode?: string;
}>;
```

- [ ] **Step 3: Add the JSON schema**

Add a strict `rtc.stream` entry in `COMMAND_SCHEMAS` with:

- `send` required
- integer `count >= 1`
- integer `durationMs >= 1`
- integer `intervalMs >= 1`
- number `rateHz > 0`
- integer `maxInFlight >= 1`
- integer `drainTimeoutMs >= 0`
- integer `progressEveryMs >= 1`
- integer `sampleEvery >= 1`
- `transport` enum restricted to `realtime` and `messages.rtc`
- `thresholds` using the fields listed above

Add command-level validation that enforces the cross-field constraints not expressible in plain JSON schema:

```ts
if (command.kind === 'rtc.stream') {
    if (command.count === undefined && command.durationMs === undefined) {
        return invalid('rtc.stream requires count or durationMs.');
    }
    if (command.intervalMs === undefined && command.rateHz === undefined) {
        return invalid('rtc.stream requires intervalMs or rateHz.');
    }
}
```

- [ ] **Step 4: Add capability docs**

In `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`, add a section describing:

- why `rtc.stream` exists;
- how it differs from `loop` plus `rtc.send`;
- placeholder names;
- result metrics;
- threshold behavior;
- when to keep using plain `rtc.send`.

- [ ] **Step 5: Verify contract tests**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared-test/rallar-bb-test/types.ts packages/shared-test/rallar-bb-test/schema.ts packages/shared-test/rallar-bb-test/control-protocol.ts packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
git commit -m "feat: add rtc stream command contract"
```

## Iteration 2: Pure Stream Planning And Metrics

Goal: keep stream scheduling math and metrics testable outside the browser adapter.

### Files

- Create: `packages/shared-test/rallar-bb-test/rtc-stream.ts`
- Modify: `packages/shared-test/rallar-bb-test/mod.ts`
- Test: `packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts`

### Steps

- [ ] **Step 1: Add failing pure helper tests**

Create tests for:

- `planRallarBlackBoxRtcStreamFrames({ count: 3, intervalMs: 50 })` returns scheduled offsets `0`, `50`, `100`.
- `planRallarBlackBoxRtcStreamFrames({ durationMs: 125, intervalMs: 50 })` returns three frames.
- `planRallarBlackBoxRtcStreamFrames({ durationMs: 5000, rateHz: 20 })` returns 100 frames with `intervalMs: 50`.
- `replaceRallarBlackBoxRtcStreamPlaceholders` resolves `{stream.index}`, `{stream.iteration}`, `{stream.elapsedMs}`, and `{stream.scheduledElapsedMs}`.
- `summarizeRallarBlackBoxRtcStreamObservations` returns p50/p95/p99/max and pacing drift from observations.
- threshold evaluation returns `maxP95SendDurationMs` and `maxDroppedFrames` failures with readable messages.

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts
```

Expected: FAIL because `rtc-stream.ts` does not exist.

- [ ] **Step 2: Implement pure helpers**

Create `packages/shared-test/rallar-bb-test/rtc-stream.ts` with these exported functions:

```ts
export function planRallarBlackBoxRtcStreamFrames(input: {
    count?: number;
    durationMs?: number;
    intervalMs?: number;
    rateHz?: number;
}): {
    intervalMs: number;
    requestedRateHz?: number;
    frames: readonly { index: number; iteration: number; scheduledElapsedMs: number; }[];
};

export function replaceRallarBlackBoxRtcStreamPlaceholders<T>(
    value: T,
    context: {
        commandId: string;
        index: number;
        iteration: number;
        elapsedMs: number;
        scheduledElapsedMs: number;
    }
): T;

export function summarizeRallarBlackBoxRtcStreamObservations(input: {
    commandId: string;
    transport?: Extract<RallarBlackBoxTestTransport, 'realtime' | 'messages.rtc'>;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    intervalMs: number;
    requestedRateHz?: number;
    plannedFrames: number;
    observations: readonly RallarBlackBoxTestRtcStreamFrameObservation[];
    thresholds?: RallarBlackBoxTestRtcStreamThresholds;
}): RallarBlackBoxTestRtcStreamResultValue;
```

Use the same percentile style as existing artifact performance analysis: sort numeric samples ascending, clamp percentile indexes, and round displayed metrics consistently with current helpers.

- [ ] **Step 3: Export helpers**

Export the helper module from `packages/shared-test/rallar-bb-test/mod.ts` only if app or tests need direct imports. Keep helper functions package-local otherwise.

- [ ] **Step 4: Verify helper tests**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared-test/rallar-bb-test/rtc-stream.ts packages/shared-test/rallar-bb-test/mod.ts packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts
git commit -m "feat: add rtc stream planning metrics"
```

## Iteration 3: Browser Adapter Streaming Runtime

Goal: execute a high-rate stream as one command without waiting for every frame before scheduling the next frame.

### Files

- Modify: `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- Modify: `packages/shared-test/rallar-bb-test/runtime.ts`
- Test: `packages/tests/shared-test/rallar-bb-test.test.ts`
- Test: `packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts`

### Steps

- [ ] **Step 1: Add failing browser adapter tests**

Add tests that create `createRallarBlackBoxBrowserTestRuntime` with a fake `rallarRuntime.send`.

Test one: scheduled sends are not sequentially blocked:

```ts
const sendStarts: number[] = [];
const runtime = createRallarBlackBoxBrowserTestRuntime({
    now: () => fakeNow,
    sleep: async (ms) => {
        fakeNow += ms;
    },
    rallarRuntime: {
        async send(input: unknown) {
            sendStarts.push(fakeNow);
            await advanceFakeAsync(200);
            return { status: 'sent', input };
        },
        async connect() {
            return { connected: true };
        },
        async health() {
            return { rtcStatus: { readyPeerIds: ['peer-1'] } };
        }
    }
});
```

Execute:

```ts
await runtime.execute({
    kind: 'rtc.stream',
    commandId: 'stream-position',
    connection: 'rtc',
    transport: 'realtime',
    count: 5,
    intervalMs: 50,
    maxInFlight: 64,
    send: { data: { seq: '{stream.index}' } }
});
```

Assert:

- command result is `ok`;
- five sends were attempted;
- send start offsets are near `0`, `50`, `100`, `150`, `200`;
- result value has `plannedFrames: 5`, `completedFrames: 5`, and p95 duration around `200ms`;
- emitted topics include `rallar.bb.rtc.stream_started` and `rallar.bb.rtc.stream_completed`.

Test two: max-in-flight saturation records dropped frames:

```ts
await runtime.execute({
    kind: 'rtc.stream',
    commandId: 'stream-saturated',
    count: 5,
    intervalMs: 10,
    maxInFlight: 1,
    drainTimeoutMs: 500,
    send: { data: { seq: '{stream.index}' } },
    thresholds: { maxDroppedFrames: 0 }
});
```

Assert result fails with `RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED`, `droppedFrames > 0`, and one threshold failure named `maxDroppedFrames`.

Test three: abort/cancellation stops scheduling and reports cancelled frames.

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts
```

Expected: FAIL because the adapter does not handle `rtc.stream`.

- [ ] **Step 2: Add adapter dispatch**

In `BrowserCommandAdapter.execute`, add:

```ts
case 'rtc.stream':
    return await this.streamRtc(command, context);
```

- [ ] **Step 3: Implement `streamRtc`**

Implementation rules:

- Resolve the stream plan before starting.
- Record `rallar.bb.rtc.stream_started`.
- For each planned frame, sleep until the scheduled time relative to command start.
- If active sends are at `maxInFlight`, record a dropped observation and continue.
- Otherwise start `this.requireRallarRuntime().send(scopedSend)` and store the promise in an in-flight set.
- Do not await that promise before scheduling the next frame.
- On send resolution, create a `RallarBlackBoxTestRtcStreamFrameObservation` from `rtcSendObservation`.
- On send failure, record the error code and keep scheduling unless cancellation occurs.
- Emit progress events every `progressEveryMs` with counts only, not full payloads.
- After all frames are scheduled, wait up to `drainTimeoutMs` for in-flight sends.
- Summarize observations with `summarizeRallarBlackBoxRtcStreamObservations`.
- Return failed status only when thresholds fail, cancellation occurs, or `continueOnSendFailure !== true` and any send failed.

Use existing helpers in `browser-adapter.ts`:

- `replaceCommandPlaceholders` for config/auth/session placeholders before stream placeholders;
- `rtcSendFailureFromDiagnostics`;
- `rtcSendObservation`;
- `withSendObservationValue`;
- `normalizeRallarBlackBoxRuntimeDiagnostic`.

- [ ] **Step 4: Keep runtime summaries aware of stream results**

Update `packages/shared-test/rallar-bb-test/runtime.ts` so `health`/`stats` load summaries can expose the latest stream result similarly to latest loop results:

```ts
load: {
    loopCount,
    latestPacing,
    latestSends,
    streamCount,
    latestStream,
}
```

Keep this additive so existing stats consumers do not break.

- [ ] **Step 5: Verify adapter tests**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared-test/rallar-bb-test/browser-adapter.ts packages/shared-test/rallar-bb-test/runtime.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts
git commit -m "feat: execute rtc stream commands"
```

## Iteration 4: Recipe Builder And Hetzner Manifest Migration

Goal: switch only the high-rate Hetzner realtime manifests from looped `rtc.send` to `rtc.stream`.

### Files

- Modify: `packages/shared-test/rallar-bb-test/recipe-fixtures.ts`
- Modify: `apps/rallar-black-box/src/distributed-recipes.ts`
- Modify: `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`
- Modify: `apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json`
- Modify: `apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json`
- Test: `packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Test: `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`

### Steps

- [ ] **Step 1: Add failing recipe and manifest tests**

In `packages/tests/rallar-black-box/distributed-recipes.test.ts`, add:

```ts
const recipe = createRallarBlackBoxRtcRealtimeRecipe({
    durationSeconds: 5,
    executionMode: 'stream',
    readyPeerCount: 1,
    readyTimeoutMs: 10_000
});

expect(recipe.commands.map((command) => command.kind)).toContain('rtc.stream');
expect(recipe.commands.map((command) => command.kind)).not.toContain('loop');

const stream = recipe.commands.find((command) => command.kind === 'rtc.stream');
expect(stream).toMatchObject({
    commandId: 'rtc-realtime-position-stream',
    count: 100,
    intervalMs: 50,
    maxInFlight: 64,
    drainTimeoutMs: 5000,
    thresholds: {
        minSendSuccessRatio: 0.99,
        maxDroppedFrames: 0
    }
});
```

Keep the existing default recipe test asserting looped `rtc.send` unchanged so local compatibility is explicit.

In `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`, assert:

- `05-rtc-realtime-2-agent-5s.json` contains `rtc.stream` with `count: 100` and no high-rate looped `rtc.send`;
- `06-rtc-realtime-3-agent-15s.json` contains `rtc.stream` with `count: 300` and no high-rate looped `rtc.send`;
- every green Hetzner manifest containing `rtc.stream` also has an earlier `rtc.connect.readiness`.

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
```

Expected: FAIL because the builder and manifests still use `loop`.

- [ ] **Step 2: Add recipe option**

Extend `RallarBlackBoxRtcRealtimeRecipeOptions`:

```ts
executionMode?: 'loop' | 'stream';
stream?: Readonly<{
    maxInFlight?: number;
    drainTimeoutMs?: number;
    progressEveryMs?: number;
    sampleEvery?: number;
}>;
```

Default to `executionMode: 'loop'` so existing callers are stable.

- [ ] **Step 3: Generate the stream command**

When `executionMode === 'stream'`, replace the loop command with:

```ts
{
    kind: 'rtc.stream',
    commandId: 'rtc-realtime-position-stream',
    connection,
    actor: '{auth.clientId}',
    transport: 'realtime',
    applicationId: group.applicationId,
    workspaceId: group.workspaceId,
    roomId: group.groupId,
    roomRef,
    count: frameCount,
    intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    maxInFlight: options.stream?.maxInFlight ?? 64,
    drainTimeoutMs: options.stream?.drainTimeoutMs ?? 5_000,
    progressEveryMs: options.stream?.progressEveryMs ?? 1_000,
    sampleEvery: options.stream?.sampleEvery ?? 1,
    thresholds: {
        minSendSuccessRatio: 0.99,
        maxDroppedFrames: 0,
    },
    metadata: {
        realtime: {
            rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            durationSeconds,
            frameCount,
            executionMode: 'stream',
        },
    },
    send: {
        roomId: group.groupId,
        roomRef,
        openTimeoutMs: 10_000,
        data: {
            topic: 'room.black-box.rtc-realtime.position',
            typeId: 'room.black-box.rtc-realtime.position',
            actor: '{auth.clientId}',
            seq: '{stream.index}',
            rateHz: RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
            intervalMs: RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
            durationSeconds,
            totalFrames: frameCount,
            tMs: '{stream.elapsedMs}',
            position: {
                frame: '{stream.iteration}',
                x: '{stream.index}',
                y: 0,
                z: '{stream.index}',
                headingDeg: '{stream.index}',
                velocityMps: 4,
            },
        },
    },
}
```

- [ ] **Step 4: Update preflight**

In `apps/rallar-black-box/src/distributed-recipes.ts`:

- show `rtc.stream` rows as `stream RTC - <transport> - <room>`;
- show `100 frames @ 20 Hz` or `300 frames @ 20 Hz` in the command preview;
- warn when a recipe uses a loop of `rtc.send` with `count >= 20` and `intervalMs <= 100` because this is command-rate testing, not realtime streaming;
- do not warn for the new Hetzner realtime manifests.

- [ ] **Step 5: Switch Hetzner realtime manifests**

Update `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`:

```ts
recipe: createRallarBlackBoxRtcRealtimeRecipe({
    durationSeconds: 5,
    executionMode: 'stream',
    group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    readyPeerCount: 1,
    readyTimeoutMs: 10_000,
}),
```

and:

```ts
recipe: createRallarBlackBoxRtcRealtimeRecipe({
    durationSeconds: 15,
    executionMode: 'stream',
    group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    readyPeerCount: 2,
    readyTimeoutMs: 10_000,
}),
```

Regenerate:

```sh
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
```

Expected: second command exits zero.

- [ ] **Step 6: Verify recipe and manifest tests**

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared-test/rallar-bb-test/recipe-fixtures.ts apps/rallar-black-box/src/distributed-recipes.ts apps/rallar-black-box/src/hetzner-distributed-manifests.ts apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
git commit -m "feat: stream hetzner realtime recipes"
```

## Iteration 5: Artifact Analyzer And Failure Evidence

Goal: report stream performance and classify pending realtime timeouts from JSONL evidence.

### Files

- Modify: `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- Modify: `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts`
- Test: `packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts`
- Test: `packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts`

### Steps

- [ ] **Step 1: Add failing analyzer tests**

Create a fixture with:

- `distributed-run.json` still `running`;
- `control-run.json` with `recipe.run` command dispatched but not completed;
- `events.jsonl` containing `rallar.bb.rtc.stream_started`, several progress events, and no completed top-level command result.

Assert `analyzeDistributedRunArtifactFiles` returns:

```ts
expect(analysis.failure).toMatchObject({
    category: 'runtime',
    title: expect.stringContaining('RTC stream did not finish'),
    evidenceFile: 'events.jsonl',
    minimalFixArea: 'shared-test/browser-adapter'
});
```

Create a passed stream result fixture in `results.jsonl` and assert:

```ts
expect(analysis.performance.rtcStreams?.[0]).toMatchObject({
    commandId: 'rtc-realtime-position-stream',
    plannedFrames: 100,
    completedFrames: 100,
    p50Ms: 24,
    p95Ms: 45,
    p99Ms: 60,
    maxMs: 67
});
```

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts
```

Expected: FAIL because analyzer does not derive stream metrics or timeout evidence.

- [ ] **Step 2: Parse stream result values**

In shared artifact analysis, add extraction from:

- `controlRun.results[*].value` where `kind === 'rtc.stream'`;
- `results.jsonl` rows where `result.kind === 'rtc.stream'`;
- `events.jsonl` summaries where topic starts with `rallar.bb.rtc.stream_`.

Deduplicate by `agentId + commandId`.

- [ ] **Step 3: Add stream performance fields**

Extend the performance output with:

```ts
rtcStreams?: readonly {
    agentId?: string;
    commandId: string;
    plannedFrames: number;
    attemptedFrames: number;
    completedFrames: number;
    failedFrames: number;
    droppedFrames: number;
    backpressureCount: number;
    achievedScheduleHz?: number;
    achievedCompletionHz?: number;
    minMs?: number;
    p50Ms?: number;
    p95Ms?: number;
    p99Ms?: number;
    maxMs?: number;
    averageMs?: number;
}[];
```

Keep existing command timing fields unchanged for compatibility.

- [ ] **Step 4: Classify pending stream timeouts**

If the distributed run is not terminal and JSONL includes an unfinished stream command, return a failure proposal with:

- category: `runtime`;
- title: `RTC stream did not finish before the distributed terminal timeout`;
- likely cause based on progress evidence: saturation, unresolved in-flight sends, send failures, or missing completion event;
- affected agents from JSONL event agent ids;
- evidence file: `events.jsonl`;
- minimal fix area: `shared-test/browser-adapter` or `recipe-fixtures` depending on the event shape;
- verification command: `npx vitest run packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts`.

- [ ] **Step 5: Verify analyzer tests**

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts
```

Expected: PASS.

Commit:

```sh
git add packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts apps/rallar-black-box/src/distributed-run-artifact-analysis.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts
git commit -m "feat: analyze rtc stream artifacts"
```

## Iteration 6: SPA Import And Performance UX

Goal: make imported distributed runs explain stream success and failure without making operators read raw JSONL.

### Files

- Modify: `apps/rallar-black-box/src/rtc-diagnostics.ts`
- Modify: `apps/rallar-black-box/src/App.tsx`
- Test: `packages/tests/rallar-black-box/distributed-artifact-spa.test.ts`
- Optional E2E: existing rallar-black-box Playwright smoke pattern if React DOM coverage is insufficient.

### Steps

- [ ] **Step 1: Add failing SPA model tests**

In `packages/tests/rallar-black-box/distributed-artifact-spa.test.ts`, create an imported analysis model with `performance.rtcStreams` and assert rendered/model text includes:

- `RTC stream`
- `Frames`
- `Attempted`
- `Completed`
- `Dropped`
- `Backpressure`
- `Achieved Hz`
- `P50`
- `P95`
- `P99`
- `Max`
- `Slowest agent`

Add a timeout fixture and assert the failure-first section includes:

- `RTC stream did not finish`
- `events.jsonl`
- affected agent ids
- a verify command

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-artifact-spa.test.ts
```

Expected: FAIL because stream metrics are not surfaced.

- [ ] **Step 2: Add stream metric rows**

In `rtc-diagnostics.ts`, add pure view-model helpers that format stream rows from shared analysis:

```ts
export function distributedRtcStreamMetricRows(
    analysis: DistributedRunArtifactAnalysis
): readonly DistributedAgentMetricCell[] {
    // Return dense cells for frames, dropped, p50, p95, p99, max, achieved Hz.
}
```

Use existing `DistributedAgentMetricCell` styling categories: good for complete/no drops, warn for drops/backpressure/outliers, bad for failed frames.

- [ ] **Step 3: Render the SPA performance band**

In `App.tsx`, extend the imported distributed artifact performance band:

- show stream summary before generic command timing when stream data exists;
- keep pass/failure verdict first;
- keep evidence warnings before raw counters;
- keep the existing `RtcPerformancePanel` operational for non-stream runs.

- [ ] **Step 4: Verify SPA tests and type-check**

Run:

```sh
npx vitest run packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected: PASS.

Commit:

```sh
git add apps/rallar-black-box/src/rtc-diagnostics.ts apps/rallar-black-box/src/App.tsx packages/tests/rallar-black-box/distributed-artifact-spa.test.ts
git commit -m "feat: show rtc stream metrics in spa"
```

## Iteration 7: Documentation And Operator Runbooks

Goal: make Codex/operator prompts and docs point at the durable stream path.

### Files

- Modify: `docs/rallar-hetzner-distributed-recipes.md`
- Modify: `skills/rallar-hetzner-ops/references/performance-thresholds.md`
- Modify: `skills/rallar-hetzner-ops/references/artifact-analysis.md`

### Steps

- [ ] **Step 1: Update manifest docs**

In `docs/rallar-hetzner-distributed-recipes.md`, document:

- `05` and `06` now use `rtc.stream`;
- expected frame counts: `05 = 100 per agent`, `06 = 300 per agent`;
- expected success analysis fields: frames, p50/p95/p99/max, achieved Hz, drops, backpressure, reconnects;
- the prompt to run `05`:

```text
Start the Hetzner distributed recipe run using
apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json on main
with fast mode enabled.

After it completes, analyse the outcome.
```

- [ ] **Step 2: Update artifact and performance references**

In `skills/rallar-hetzner-ops/references/performance-thresholds.md`, add stream reporting expectations:

- pass rate;
- stream completed frame ratio;
- p50/p95/p99/max send duration;
- achieved schedule/completion Hz;
- dropped/backpressure counts;
- reconnect count;
- diagnostic severity counts.

In `skills/rallar-hetzner-ops/references/artifact-analysis.md`, say that stream failures should start from `analysis.json`, then stream rows in `results.jsonl`, then stream topics in `events.jsonl`.

- [ ] **Step 3: Verify docs have no stale loop wording**

Run:

```sh
rg -n "05-rtc-realtime|06-rtc-realtime|looped 20 Hz|loop x100|loop x300|rtc.stream" docs skills apps/rallar-black-box/src packages/shared-test/rallar-bb-test/docs
```

Expected: output contains the new stream documentation and no user-facing claim that the Hetzner realtime manifests are looped command-rate runs.

Commit:

```sh
git add docs/rallar-hetzner-distributed-recipes.md skills/rallar-hetzner-ops/references/performance-thresholds.md skills/rallar-hetzner-ops/references/artifact-analysis.md
git commit -m "docs: document rtc stream distributed runs"
```

## Iteration 8: Local Verification Gate

Goal: prove the full local contract before pushing to `main`.

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts
npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
git diff --check
```

Expected:

- every Vitest command exits zero;
- manifest generator `--check` exits zero;
- TypeScript exits zero;
- whitespace check exits zero.

If `distributed-artifact-spa.test.ts` cannot exercise the rendered import surface, add one Playwright smoke test under the existing rallar-black-box E2E pattern that imports a stream artifact fixture and verifies `P50`, `P95`, `P99`, `Frames`, and `Dropped` are visible.

Commit any test or fixture adjustments:

```sh
git add packages/tests apps/rallar-black-box packages/shared-test docs skills
git commit -m "test: verify rtc stream distributed workflow"
```

## Iteration 9: Remote Rollout And Baseline Verification

Goal: prove the durable fix against Hetzner, first in full rollout mode and then in fast iteration mode.

### Steps

- [ ] **Step 1: Push to `main`**

Use the repository’s normal integration path. The workflow can only read committed manifests on the selected ref.

- [ ] **Step 2: Run full rollout for `05`**

Run:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json \
  --ref main
```

Expected:

- workflow succeeds;
- two agents register;
- `rtc.connect.readiness` passes;
- stream command completes on both agents;
- analysis artifact includes `rtcStreams`;
- pass rate is `1`;
- dropped frames are `0` or explicitly justified by thresholds;
- reconnect count is `0`.

- [ ] **Step 3: Run fast `05`**

Run:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json \
  --ref main \
  --fast
```

Expected: same functional result with shorter setup time.

- [ ] **Step 4: Run fast `06`**

Run:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json \
  --ref main \
  --fast
```

Expected:

- three agents register;
- `minReadyPeers: 2` passes for every agent;
- each agent schedules 300 frames;
- analysis shows stream percentiles and slowest agents;
- the run finishes inside the existing fast terminal timeout or the evidence clearly supports increasing `terminal_timeout_seconds` for the larger baseline.

- [ ] **Step 5: Import artifacts into the SPA**

Download the raw distributed artifact directory and import it in the `rallar-black-box` Runs panel with `Import CI artifact`.

Expected visible SPA evidence:

- verdict;
- pass rate;
- frame counts;
- p50/p95/p99/max;
- achieved Hz;
- dropped/backpressure counts;
- reconnects;
- slowest agents;
- evidence quality warnings only when optional JSONL rows are malformed or missing.

## Acceptance Criteria

- `05-rtc-realtime-2-agent-5s.json` passes remotely without relying on hundreds of top-level child command completions.
- `06-rtc-realtime-3-agent-15s.json` either passes or fails with a specific stream metric/failure explanation, not an unknown pending-run message.
- The analyzer reports stream metrics from both `results.jsonl` and `events.jsonl`.
- The SPA import view uses the same normalized artifact analysis as the CLI and displays stream metrics clearly.
- Existing looped `rtc.send` tests continue to pass.
- Existing non-realtime Hetzner manifests are unchanged except for generated metadata ordering if the generator already owns it.

## Rollback Plan

- Keep `createRallarBlackBoxRtcRealtimeRecipe({ executionMode: 'loop' })` as the compatibility path.
- If remote `rtc.stream` has an adapter bug, revert only the manifest builder calls in `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` to omit `executionMode: 'stream'`, regenerate manifests, and rerun the existing looped tests.
- Do not remove the `rtc.stream` schema once committed unless no released manifest or artifact uses it.

## Risks And Mitigations

- **Risk:** `rallarRuntime.send` itself serializes internally, so parallel scheduling still queues at a deeper layer.
  **Mitigation:** stream result reports achieved completion Hz and in-flight backlog; if this happens, the next fix belongs in the browser runtime send path rather than recipe orchestration.

- **Risk:** per-frame progress events recreate control-plane pressure.
  **Mitigation:** default stream result is one command result; progress is aggregate and controlled by `progressEveryMs` and `sampleEvery`.

- **Risk:** long streams keep too many promises in memory.
  **Mitigation:** `maxInFlight` defaults to `64`, records saturation, and can be tuned per manifest.

- **Risk:** stream thresholds make first baselines too strict.
  **Mitigation:** start with delivery safety thresholds (`minSendSuccessRatio`, `maxDroppedFrames`) and report latency percentiles as baseline data before enforcing latency gates.

- **Risk:** analyzer duplicates command timing and stream timing.
  **Mitigation:** keep stream metrics in a separate `rtcStreams` section and leave existing `commandTiming` as wrapper command timing.

## Final Verification Checklist

- [ ] `npx vitest run packages/tests/shared-test/rallar-bb-test-rtc-stream.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-diagnostics.test.ts`
- [ ] `npx vitest run packages/tests/rallar-black-box/distributed-recipes.test.ts packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts packages/tests/rallar-black-box/distributed-artifact-spa.test.ts packages/tests/rallar-black-box/rtc-diagnostics.test.ts`
- [ ] `npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check`
- [ ] `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit`
- [ ] `git diff --check`
- [ ] Full rollout `05` on `main` passes.
- [ ] Fast `05` on `main` passes.
- [ ] Fast `06` on `main` produces stream stats and either passes or fails with specific stream evidence.
