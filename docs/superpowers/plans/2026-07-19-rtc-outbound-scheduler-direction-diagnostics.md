# RTC Outbound Scheduler Direction Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add behavior-neutral outbound finalization and durable-effect
composition diagnostics, analyze them from the unchanged 15-agent RTC artifact,
and use iteration 11 to select the next performance code boundary.

**Architecture:** Keep the existing public diagnostics import path in
`ALOutboundMessageRuntime.ts` and put bounded effect-composition accounting in a
focused helper module. Emit one finalization event per committed bundle and
enrich the existing drain event with kind, attempt, outcome, and ready-lateness
aggregates. A reusable Node analyzer disambiguates original enqueue work from
later dequeue work sharing the same message ID.

**Tech Stack:** TypeScript, Vitest, Node.js ESM, Rallar shared/shared-web/
shared-test packages, GitHub Actions, Hetzner distributed black-box runner.

## Global Constraints

- Keep branch `codex/rtc-signaling-boundary-diagnostics` and draft PR #40.
- The second series may use at most ten remote runs, numbered 11-20 overall; it
  starts at 0/10.
- Keep the 15-agent manifest, 5 Hz rate, 150 frames, tree topology, delivery
  semantics, and p95/p99 thresholds unchanged.
- Iteration 11 changes diagnostics only. Do not change scheduling, retry,
  persistence, or delivery behavior.
- Allocate aggregate diagnostics only when the optional sink is installed.
- Every effect kind and histogram bucket is mandatory and numeric, including
  zero values.
- Keep downloaded artifacts and analyzer output under `/private/tmp` or ignored
  `tmp/perf/` paths.

---

### Task 1: Label committed finalization

**Files:**

- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts:34,128-169,205,374-402`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts:449-610,1230-1270`

**Interfaces:**

- Consumes: `ALOutboundComputeIntent`, `ALOutboundDispatchPhase`,
  `ALOutboundEnqueueStatus`, and `ALOutboundRuntimeMessageDiagnostics`.
- Produces: `ALOutboundFinalizationMode` and an
  `outbound-finalization` diagnostic event.

- [x] **Step 1: Write failing finalization assertions**

Extend the immediate-send diagnostics test:

```ts
expect(diagnostics.mock.calls).toContainEqual([
    expect.objectContaining({
        kind: 'outbound-finalization',
        runtime: 'test-outbound',
        message: expect.objectContaining({ msgId: message.id.msgId }),
        intent: 'enqueue',
        phase: 'immediate',
        resultStatus: 'sent-immediate',
        mode: 'awaited-new-drain',
        hadActiveDrain: false,
        durationMs: expect.any(Number),
    }),
]);
```

In the existing active-drain persisted-enqueue test, install `diagnostics` and
select the finalization by `persistedMessage.id.msgId`:

```ts
expect(diagnostics.mock.calls.map(([event]) => event).find(event =>
    event.kind === 'outbound-finalization' &&
    event.message.msgId === persistedMessage.id.msgId
)).toMatchObject({
    intent: 'enqueue',
    phase: 'immediate',
    resultStatus: 'enqueued',
    mode: 'background-existing-drain',
    hadActiveDrain: true,
});
```

In the existing persistent enqueue test require `awaited-new-drain`. In
`persists repair dispatches when the repair planner requests outbox durability`
install the sink and require `intent: 'repair'` and `mode: 'deferred'`.

- [x] **Step 2: Verify RED**

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected: FAIL because `outbound-finalization` does not exist.

- [x] **Step 3: Add the event contract and preserve behavior**

Export:

```ts
export type ALOutboundComputeIntent = 'enqueue' | 'dequeue' | 'repair';
export type ALOutboundFinalizationMode =
    | 'background-existing-drain'
    | 'awaited-existing-drain'
    | 'awaited-new-drain'
    | 'deferred';
```

Add this event variant:

```ts
| Readonly<{
    kind: 'outbound-finalization';
    message: ALOutboundRuntimeMessageDiagnostics;
    intent: ALOutboundComputeIntent;
    phase: ALOutboundDispatchPhase;
    resultStatus: ALOutboundEnqueueStatus;
    mode: ALOutboundFinalizationMode;
    hadActiveDrain: boolean;
    durationMs: number;
}>
```

Replace only the post-commit branch:

```ts
if (result.committed) {
    const finalizationStartedAtMs = this.readNowMs();
    const hadActiveDrain = this.effectDrainPromise !== undefined;
    let mode: ALOutboundFinalizationMode;
    if (options.deferEffectDrain) {
        mode = 'deferred';
    } else if (result.computed.status === 'enqueued' && hadActiveDrain) {
        mode = 'background-existing-drain';
        this.requestEffectDrain();
    } else {
        mode = hadActiveDrain ? 'awaited-existing-drain' : 'awaited-new-drain';
        await this.finalizeCommittedOutbound();
    }
    this.emitDiagnostics({
        kind: 'outbound-finalization',
        message: this.toMessageDiagnostics(msg),
        intent,
        phase,
        resultStatus: result.computed.status,
        mode,
        hadActiveDrain,
        durationMs: this.elapsedSince(finalizationStartedAtMs),
    });
}
```

Do not change `finalizeCommittedOutbound()`, `requestEffectDrain()`, or the
returned result.

- [x] **Step 4: Verify GREEN and commit**

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts
git add packages/shared/alm/ALOutboundMessageRuntime.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts
git commit -m "feat: label outbound finalization diagnostics"
```

Expected: the focused test file passes and existing synchronous-send semantics
remain proven.

---

### Task 2: Aggregate drain composition

**Files:**

- Create: `packages/shared/alm/ALOutboundRuntimeDiagnostics.ts`
- Modify: `packages/shared/alm/ALOutboundMessageRuntime.ts:1-22,155-165,695-840`
- Test: `packages/tests/shared/al-outbound-message-runtime.test.ts:520-610`

**Interfaces:**

- Consumes: claimed `ALPersistedOutboundEffect<unknown>`, batch claim time, and
  final settlement status.
- Produces: `ALOutboundEffectDrainComposition` plus create/record/snapshot
  helpers.

- [x] **Step 1: Write the failing retry-composition test**

```ts
it('reports effect kind, attempt, outcome, and ready lateness', async () => {
    vi.useFakeTimers();
    let nowMs = 1_000;
    let attempts = 0;
    const diagnostics = vi.fn();
    const runtime = createOutboundRuntime({
        diagnostics,
        nowMs: () => nowMs,
        sendPreparedMessage: async () => {
            attempts += 1;
            return attempts === 1
                ? { status: 'not-ready' as const, reason: 'lane unavailable' }
                : { status: 'sent' as const };
        },
        planOutgoingMessage: () => ({
            persist: false,
            preparedMessages: [{ kind: 'send' }],
        }),
    });
    await runtime.enqueueIfAbsent(createOutboundMessage('msg-composition'));
    nowMs = 1_300;
    await vi.advanceTimersByTimeAsync(50);
    await waitUntil(() => attempts === 2);
    const drains = diagnostics.mock.calls.map(([event]) => event)
        .filter(event => event.kind === 'effect-drain' && event.claimedCount > 0);
    expect(drains).toHaveLength(2);
    expect(drains[0]).toMatchObject({
        claimedByKind: {
            'send-prepared': 1, 'enqueue-outbox': 0,
            'fallback-dispatch': 0, 'ack-timeout': 0,
            'repair-hint': 0, 'nack-retry': 0,
        },
        rescheduledByKind: expect.objectContaining({ 'send-prepared': 1 }),
        claimedFirstAttemptCount: 1,
        claimedRetryAttemptCount: 0,
        firstAttemptReadyLateness: expect.objectContaining({ le0Ms: 1 }),
    });
    expect(drains[1]).toMatchObject({
        completedByKind: expect.objectContaining({ 'send-prepared': 1 }),
        claimedFirstAttemptCount: 0,
        claimedRetryAttemptCount: 1,
        retryAttemptReadyLateness: expect.objectContaining({ le250Ms: 1 }),
    });
    runtime.dispose();
});
```

- [x] **Step 2: Verify RED**

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts
```

Expected: FAIL because composition fields are absent.

- [x] **Step 3: Create the bounded accumulator**

Create `ALOutboundRuntimeDiagnostics.ts` with:

```ts
import type {
    ALOutboundEffectSettlement,
    ALPersistedOutboundEffect,
} from './ALOutboundAdmissionStore.ts';

export type ALOutboundEffectKind =
    ALPersistedOutboundEffect<unknown>['payload']['kind'];
export type ALOutboundEffectKindCounts =
    Readonly<Record<ALOutboundEffectKind, number>>;
export type ALOutboundEffectReadyLatenessHistogram = Readonly<{
    le0Ms: number; le10Ms: number; le50Ms: number; le100Ms: number;
    le250Ms: number; le500Ms: number; le1000Ms: number; le2500Ms: number;
    le5000Ms: number; gt5000Ms: number;
}>;
export type ALOutboundEffectDrainComposition = Readonly<{
    claimedByKind: ALOutboundEffectKindCounts;
    completedByKind: ALOutboundEffectKindCounts;
    rescheduledByKind: ALOutboundEffectKindCounts;
    claimedFirstAttemptCount: number;
    claimedRetryAttemptCount: number;
    firstAttemptReadyLateness: ALOutboundEffectReadyLatenessHistogram;
    retryAttemptReadyLateness: ALOutboundEffectReadyLatenessHistogram;
}>;
type MutableCounts = Record<ALOutboundEffectKind, number>;
type MutableHistogram =
    Record<keyof ALOutboundEffectReadyLatenessHistogram, number>;
export type ALOutboundEffectDrainAccumulator = {
    claimedByKind: MutableCounts;
    completedByKind: MutableCounts;
    rescheduledByKind: MutableCounts;
    claimedFirstAttemptCount: number;
    claimedRetryAttemptCount: number;
    firstAttemptReadyLateness: MutableHistogram;
    retryAttemptReadyLateness: MutableHistogram;
};
const zeroCounts = (): MutableCounts => ({
    'send-prepared': 0, 'enqueue-outbox': 0, 'fallback-dispatch': 0,
    'ack-timeout': 0, 'repair-hint': 0, 'nack-retry': 0,
});
const zeroHistogram = (): MutableHistogram => ({
    le0Ms: 0, le10Ms: 0, le50Ms: 0, le100Ms: 0, le250Ms: 0,
    le500Ms: 0, le1000Ms: 0, le2500Ms: 0, le5000Ms: 0, gt5000Ms: 0,
});
export function createOutboundEffectDrainAccumulator():
    ALOutboundEffectDrainAccumulator {
    return {
        claimedByKind: zeroCounts(), completedByKind: zeroCounts(),
        rescheduledByKind: zeroCounts(), claimedFirstAttemptCount: 0,
        claimedRetryAttemptCount: 0,
        firstAttemptReadyLateness: zeroHistogram(),
        retryAttemptReadyLateness: zeroHistogram(),
    };
}
function recordLateness(target: MutableHistogram, valueMs: number): void {
    const value = Math.max(0, valueMs);
    const key: keyof MutableHistogram = value <= 0 ? 'le0Ms'
        : value <= 10 ? 'le10Ms' : value <= 50 ? 'le50Ms'
        : value <= 100 ? 'le100Ms' : value <= 250 ? 'le250Ms'
        : value <= 500 ? 'le500Ms' : value <= 1_000 ? 'le1000Ms'
        : value <= 2_500 ? 'le2500Ms' : value <= 5_000 ? 'le5000Ms'
        : 'gt5000Ms';
    target[key] += 1;
}
export function recordOutboundEffectClaim(
    target: ALOutboundEffectDrainAccumulator,
    effect: ALPersistedOutboundEffect<unknown>,
    claimStartedAtMs: number,
): void {
    target.claimedByKind[effect.payload.kind] += 1;
    const first = effect.attempts === 1;
    if (first) target.claimedFirstAttemptCount += 1;
    else target.claimedRetryAttemptCount += 1;
    recordLateness(
        first ? target.firstAttemptReadyLateness : target.retryAttemptReadyLateness,
        claimStartedAtMs - effect.retryAtMs,
    );
}
export function recordOutboundEffectOutcome(
    target: ALOutboundEffectDrainAccumulator,
    effect: ALPersistedOutboundEffect<unknown>,
    status: ALOutboundEffectSettlement['status'],
): void {
    (status === 'completed'
        ? target.completedByKind
        : target.rescheduledByKind)[effect.payload.kind] += 1;
}
export function snapshotOutboundEffectDrainComposition(
    target: ALOutboundEffectDrainAccumulator,
): ALOutboundEffectDrainComposition {
    return {
        claimedByKind: { ...target.claimedByKind },
        completedByKind: { ...target.completedByKind },
        rescheduledByKind: { ...target.rescheduledByKind },
        claimedFirstAttemptCount: target.claimedFirstAttemptCount,
        claimedRetryAttemptCount: target.claimedRetryAttemptCount,
        firstAttemptReadyLateness: { ...target.firstAttemptReadyLateness },
        retryAttemptReadyLateness: { ...target.retryAttemptReadyLateness },
    };
}
```

- [x] **Step 4: Wire it into the existing drain**

Add all seven composition fields to the `effect-drain` event. Create the
accumulator only when `this.input.diagnostics` exists. Capture
`claimStartedAtMs` before every claim, record each claimed effect, and associate
final settlements by effect ID:

```ts
const effectsById = new Map(claimed.map(effect => [effect.effectId, effect]));
for (const settlement of settled) {
    const effect = effectsById.get(settlement.effectId);
    if (effect && effectComposition) {
        recordOutboundEffectOutcome(effectComposition, effect, settlement.status);
    }
}
```

In `finally`, emit only when the accumulator exists and spread
`snapshotOutboundEffectDrainComposition(effectComposition)` into the current
event.

- [x] **Step 5: Verify and commit**

```sh
npx vitest run packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
git add packages/shared/alm/ALOutboundRuntimeDiagnostics.ts \
  packages/shared/alm/ALOutboundMessageRuntime.ts \
  packages/tests/shared/al-outbound-message-runtime.test.ts
git commit -m "feat: report outbound effect drain composition"
```

Expected: both test files and the shared typecheck pass.

---

### Task 3: Add the artifact analyzer

**Files:**

- Create: `scripts/perf/analyze-rtc-outbound-runtime.mjs`
- Create: `packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts`
- Modify: `scripts/perf/README.md`

**Interfaces:**

- Consumes: parsed `events.jsonl` rows.
- Produces: `analyzeRtcOutboundRuntimeEvents(events)` and CLI JSON containing
  fleet/per-agent enqueue coverage, per-mode timings, drain totals, and
  evidence errors.

- [x] **Step 1: Write a failing synthetic analyzer test**

Use two completed stream messages, one matching enqueue finalization, one later
dequeue finalization with the same message ID, one missing enqueue match, and
one drain event. Require:

```js
expect(analysis.coverage).toEqual({
  completedStreamMessages: 2,
  matchedEnqueueFinalizations: 1,
  missingEnqueueFinalizations: 1,
  ambiguousEnqueueFinalizations: 0,
});
expect(analysis.enqueueByMode['awaited-new-drain'])
  .toMatchObject({ count: 1 });
expect(analysis.drainComposition.claimedByKind)
  .toMatchObject({ 'enqueue-outbox': 1, 'send-prepared': 3 });
expect(analysis.agents['controller-01'].drainComposition.claimedByKind)
  .toMatchObject({ 'enqueue-outbox': 1, 'send-prepared': 3 });
expect(analysis.evidenceErrors[0])
  .toContain('missing enqueue finalization');
```

- [x] **Step 2: Verify RED**

```sh
npx vitest run packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts
```

Expected: FAIL because the module is absent.

- [x] **Step 3: Implement the pure analyzer**

The module must:

1. filter `rallar.browser.al.outbound_runtime` events to `rtc-overlay`;
2. group finalizations by `agentId + "\\0" + msgId` and exclude completion
   diagnostics whose nested transport outcome is not `status: enqueued`;
3. select the earliest `intent: enqueue` / `phase: immediate` event no later
   than each `rallar.browser.messages.rtc.send_completed` event;
4. count zero, one, and multiple enqueue matches as missing, matched, and
   ambiguous coverage;
5. compute count/min/p50/p95/p99/max/average for finalization and send duration
   by all four modes;
6. sum kind counts, attempt counts, and histogram buckets across drains at the
   fleet and per-agent levels; and
7. emit evidence errors for an empty completion sample or missing/ambiguous
   coverage.

Implement the pure boundary with explicit zero-valued keys:

```js
const MODES = [
  'background-existing-drain', 'awaited-existing-drain',
  'awaited-new-drain', 'deferred',
];
const EFFECT_KINDS = [
  'send-prepared', 'enqueue-outbox', 'fallback-dispatch',
  'ack-timeout', 'repair-hint', 'nack-retry',
];
const HISTOGRAM_KEYS = [
  'le0Ms', 'le10Ms', 'le50Ms', 'le100Ms', 'le250Ms',
  'le500Ms', 'le1000Ms', 'le2500Ms', 'le5000Ms', 'gt5000Ms',
];
const numericRecord = keys =>
  Object.fromEntries(keys.map(key => [key, 0]));
const addRecord = (target, source) => {
  for (const key of Object.keys(target)) target[key] += Number(source?.[key] ?? 0);
};
const percentile = (values, quantile) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * quantile) - 1,
  )];
};
const stats = values => ({
  count: values.length,
  min: values.length ? Math.min(...values) : null,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: values.length ? Math.max(...values) : null,
  average: values.length
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null,
});

export function analyzeRtcOutboundRuntimeEvents(events) {
  const runtimeEvents = events
    .filter(event =>
      event.value?.topic === 'rallar.browser.al.outbound_runtime'
    )
    .map(event => ({
      agentId: event.agentId,
      atEpochMs: event.value?.payload?.atEpochMs ?? event.atEpochMs,
      ...event.value.payload.data,
    }))
    .filter(event => event.runtime === 'rtc-overlay');
  const finalizationsByMessage = new Map();
  const drains = [];
  for (const event of runtimeEvents) {
    if (event.kind === 'outbound-finalization') {
      const key = event.agentId + '\0' + event.message.msgId;
      const bucket = finalizationsByMessage.get(key) ?? [];
      bucket.push(event);
      finalizationsByMessage.set(key, bucket);
    } else if (event.kind === 'effect-drain') {
      drains.push(event);
    }
  }
  const completions = events.flatMap(event => {
    if (
      event.value?.topic !==
        'rallar.browser.messages.rtc.send_completed'
    ) return [];
    const outcome = event.value.payload.data?.message;
    if (outcome?.status !== 'enqueued') return [];
    const message = outcome.message;
    if (
      !message ||
      message.payload?.typeId !== 'black-box.group.multicast.position'
    ) return [];
    return [{
      agentId: event.agentId,
      atEpochMs: event.value?.payload?.atEpochMs ?? event.atEpochMs,
      message,
    }];
  });
  const matched = [];
  let missing = 0;
  let ambiguous = 0;
  for (const completion of completions) {
    const key = completion.agentId + '\0' + completion.message.id.msgId;
    const candidates = (finalizationsByMessage.get(key) ?? [])
      .filter(event =>
        event.intent === 'enqueue' &&
        event.phase === 'immediate' &&
        event.atEpochMs <= completion.atEpochMs
      )
      .sort((left, right) => left.atEpochMs - right.atEpochMs);
    if (candidates.length === 0) {
      missing += 1;
      continue;
    }
    if (candidates.length > 1) ambiguous += 1;
    matched.push({
      ...candidates[0],
      sendDurationMs:
        completion.atEpochMs - completion.message.id.ts,
    });
  }
  const enqueueByMode = Object.fromEntries(MODES.map(mode => {
    const selected = matched.filter(event => event.mode === mode);
    return [mode, {
      count: selected.length,
      finalizationDurationMs: stats(selected.map(event => event.durationMs)),
      sendDurationMs: stats(selected.map(event => event.sendDurationMs)),
    }];
  }));
  const drainComposition = {
    claimedByKind: numericRecord(EFFECT_KINDS),
    completedByKind: numericRecord(EFFECT_KINDS),
    rescheduledByKind: numericRecord(EFFECT_KINDS),
    claimedFirstAttemptCount: 0,
    claimedRetryAttemptCount: 0,
    firstAttemptReadyLateness: numericRecord(HISTOGRAM_KEYS),
    retryAttemptReadyLateness: numericRecord(HISTOGRAM_KEYS),
  };
  for (const drain of drains) {
    addRecord(drainComposition.claimedByKind, drain.claimedByKind);
    addRecord(drainComposition.completedByKind, drain.completedByKind);
    addRecord(drainComposition.rescheduledByKind, drain.rescheduledByKind);
    addRecord(
      drainComposition.firstAttemptReadyLateness,
      drain.firstAttemptReadyLateness,
    );
    addRecord(
      drainComposition.retryAttemptReadyLateness,
      drain.retryAttemptReadyLateness,
    );
    drainComposition.claimedFirstAttemptCount +=
      Number(drain.claimedFirstAttemptCount ?? 0);
    drainComposition.claimedRetryAttemptCount +=
      Number(drain.claimedRetryAttemptCount ?? 0);
  }
  const evidenceErrors = [];
  if (missing > 0) {
    evidenceErrors.push(
      missing + ' completed stream messages are missing enqueue finalization diagnostics.',
    );
  }
  if (ambiguous > 0) {
    evidenceErrors.push(
      ambiguous + ' completed stream messages have ambiguous enqueue finalization diagnostics.',
    );
  }
  return {
    coverage: {
      completedStreamMessages: completions.length,
      matchedEnqueueFinalizations: matched.length,
      missingEnqueueFinalizations: missing,
      ambiguousEnqueueFinalizations: ambiguous,
    },
    enqueueByMode,
    drainComposition,
    evidenceErrors,
  };
}
```

Add this complete CLI boundary:

```js
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n')
    .filter(line => line.trim().length > 0).map(JSON.parse);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const artifactDir = process.argv[2];
  if (!artifactDir) {
    throw new Error(
      'Usage: node analyze-rtc-outbound-runtime.mjs <artifact-directory>',
    );
  }
  const result = analyzeRtcOutboundRuntimeEvents(
    readJsonl(path.join(artifactDir, 'events.jsonl')),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.evidenceErrors.length > 0) process.exitCode = 2;
}
```

Use nearest-rank percentiles (`Math.ceil(count * quantile) - 1`). Missing
diagnostics in iteration 10 must produce exit 2 rather than throw.

- [x] **Step 4: Document, verify, and commit**

Add the command and exit-code contract to `scripts/perf/README.md`:

```sh
node scripts/perf/analyze-rtc-outbound-runtime.mjs \
  /path/to/hetzner-distributed-dist-run \
  > tmp/perf/results/rtc-outbound-runtime-run.json
```

Then run:

```sh
npx vitest run packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts
node scripts/perf/analyze-rtc-outbound-runtime.mjs \
  /private/tmp/rtc-durable-enqueue-r10-29687265298.H4p3Rd/hetzner-distributed-dist-rtc-durable-enqueue-r10-20260719T123400Z
git add scripts/perf/analyze-rtc-outbound-runtime.mjs \
  packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts scripts/perf/README.md
git commit -m "test: analyze RTC outbound scheduler evidence"
```

Expected: synthetic tests pass; the legacy artifact exits 2 with a coverage
error, not a parse crash.

---

### Task 4: Verify and publish the measurement head

**Files:**

- Modify: `docs/superpowers/plans/2026-07-19-rtc-outbound-scheduler-direction-diagnostics.md`

- [x] **Step 1: Run the full focused surface**

```sh
npx vitest run \
  packages/tests/shared/al-outbound-message-runtime.test.ts \
  packages/tests/shared/al-indexeddb-runtime-stores.test.ts \
  packages/tests/shared/webrtc-overlay-services.test.ts \
  packages/tests/shared/multicast-policy-integration.test.ts \
  packages/tests/shared-web/rallar-operation-options.test.ts \
  packages/tests/shared-test/rallar-browser-runtime.test.ts \
  packages/tests/shared-web/browser-middleware-rtt.test.ts \
  packages/tests/scripts/analyze-rtc-outbound-runtime.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-test run check
```

Expected: every selected test and typecheck exits 0.

#### Verification evidence

- Focused Vitest surface: 8 files passed, 137 tests passed, 0 failed.
- `npx tsc -p packages/shared/tsconfig.json --noEmit`: exit 0.
- `npx tsc -p packages/shared-web/tsconfig.json --noEmit`: exit 0.
- `npx tsc -p packages/shared-server/tsconfig.json --noEmit`: exit 0.
- `npm --workspace @ar-eye-hunter/shared-test run check`: exit 0; TypeScript
  and all seven Deno entry-point checks passed.
- Legacy iteration-10 artifact: analyzer found 2,057 completed stream messages,
  reported 2,057 missing finalization diagnostics, and exited 2 as required.

- [x] **Step 2: Record exact evidence and commit**

Add a `Verification evidence` section with test count and each command outcome,
mark Tasks 1-3 complete, then:

```sh
git add docs/superpowers/plans/2026-07-19-rtc-outbound-scheduler-direction-diagnostics.md
git commit -m "docs: record outbound diagnostic verification"
git push origin HEAD
```

- [ ] **Step 3: Verify the PR head**

```sh
git rev-parse HEAD
gh pr view 40 --repo intact-software-systems/ar-eye-hunter \
  --json headRefOid,isDraft,state,url
```

Expected: local HEAD equals `headRefOid` and PR #40 remains open and draft.

---

### Task 5: Run and interpret iteration 11

**Files:**

- Modify:
  `docs/superpowers/specs/2026-07-19-rtc-outbound-scheduler-direction-diagnostics-design.md`
- Modify:
  `docs/superpowers/plans/2026-07-19-rtc-outbound-scheduler-direction-diagnostics.md`

- [ ] **Step 1: Dispatch a full rollout outside the network sandbox**

```sh
diagnostic_run_id="rtc-outbound-direction-r11-$(date -u +%Y%m%dT%H%M%SZ)"
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/12-rtc-messages-all-peer-15-agent-30s-5hz-tree.json \
  --ref codex/rtc-signaling-boundary-diagnostics \
  --run-id "$diagnostic_run_id" \
  --terminal-timeout-seconds 330
```

Do not use `--fast`. Once GitHub accepts the dispatch, record series count 1/10.

- [ ] **Step 2: Resolve and monitor the exact workflow**

```sh
github_run_id="$(gh run list --repo intact-software-systems/ar-eye-hunter \
  --workflow hetzner-distributed-recipe.yml \
  --branch codex/rtc-signaling-boundary-diagnostics \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch "$github_run_id" \
  --repo intact-software-systems/ar-eye-hunter --exit-status
```

A nonzero recipe gate is allowed only if artifact upload completed.

- [ ] **Step 3: Download and resolve artifact directories**

```sh
github_run_id="$(gh run list --repo intact-software-systems/ar-eye-hunter \
  --workflow hetzner-distributed-recipe.yml \
  --branch codex/rtc-signaling-boundary-diagnostics \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
artifact_root="/private/tmp/rtc-outbound-direction-r11-${github_run_id}"
mkdir -p "$artifact_root"
gh run download "$github_run_id" \
  --repo intact-software-systems/ar-eye-hunter --dir "$artifact_root"
find "$artifact_root" -maxdepth 3 -type f | sort
artifact_bundle="$(find "$artifact_root" -maxdepth 1 -type d \
  -name 'hetzner-distributed-dist-*' -print -quit)"
analysis_bundle="$(find "$artifact_root" -maxdepth 1 -type d \
  -name 'hetzner-distributed-analysis-*' -print -quit)"
test -n "$artifact_bundle"
test -n "$analysis_bundle"
```

- [ ] **Step 4: Read authoritative evidence in order**

Read `analysis.json`, then failure `fix-proposal.md`, cited raw evidence,
`performance.md`, and `fleet-report.json.failureSignatures`. Reject the run for
direction selection if parse warnings are nonempty or required files are absent.

- [ ] **Step 5: Run the analyzer and select exactly one boundary**

```sh
github_run_id="$(gh run list --repo intact-software-systems/ar-eye-hunter \
  --workflow hetzner-distributed-recipe.yml \
  --branch codex/rtc-signaling-boundary-diagnostics \
  --limit 1 --json databaseId --jq '.[0].databaseId')"
artifact_root="/private/tmp/rtc-outbound-direction-r11-${github_run_id}"
artifact_bundle="$(find "$artifact_root" -maxdepth 1 -type d \
  -name 'hetzner-distributed-dist-*' -print -quit)"
node scripts/perf/analyze-rtc-outbound-runtime.mjs "$artifact_bundle" \
  > /private/tmp/rtc-outbound-direction-r11-analysis.json
```

Require exit 0 and zero evidence errors. Record stream frames, failures, drops,
p50/p95/p99/max, achieved Hz, slow agents, per-mode finalization/send duration,
kind outcomes, attempt totals, and both lateness histograms.

Choose:

- completion semantics if persisted enqueue finalization explains the tail;
- separate effect-class service guarantees if retry `send-prepared` claims
  dominate and fresh `enqueue-outbox` lateness grows; or
- narrower IndexedDB/coordination diagnostics if both are prompt.

- [ ] **Step 6: Record and push iteration 11**

Add iteration outcome, commit/run/control/distributed IDs, artifact path, all
metrics, interpretation, and keep/revert decision to the spec and this plan:

```sh
git add \
  docs/superpowers/specs/2026-07-19-rtc-outbound-scheduler-direction-diagnostics-design.md \
  docs/superpowers/plans/2026-07-19-rtc-outbound-scheduler-direction-diagnostics.md
git commit -m "docs: record RTC outbound direction run"
git push origin HEAD
```

- [ ] **Step 7: Transition from evidence to the long-term answer**

If one boundary is established, write a separate production design and plan
covering API semantics, worker ownership/liveness, fairness/backpressure,
restart recovery, IndexedDB transactions, observability, compatibility, and
focused/distributed acceptance. If ambiguous, define one narrower measurement
for iteration 12. Never combine competing behavior changes and never exceed
iteration 20 overall / 10 additional runs.

---

## Self-review

- Spec coverage: all finalization modes, effect kind/attempt/outcome/lateness,
  bounded overhead, artifact coverage, unchanged workload, rejection rules,
  iteration cap, and long-term handoff map to concrete tasks.
- Placeholder scan: workflow and artifact IDs are resolved by commands; code
  behavior and field names are fully specified.
- Type consistency: finalization, composition, histogram, analyzer, and test
  names match across every task.
