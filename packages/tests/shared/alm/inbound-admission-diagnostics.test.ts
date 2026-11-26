import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALMessageHandlingPlan } from '@shared/al-contracts/al-policy.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { ALInboundAcknowledgementEvidence } from '@shared/alm/inbound/control/al-inbound-acknowledgement-evidence.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { INBOX_OUTBOX_ENGINE_MAX_IDLE_MS, InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import {
    createInboundTestMessage,
    createInboundTestRuntime,
    createInboundTestStores,
    INBOUND_TEST_SENDER_PEER_ID,
    setNextInboundAdmissionParked,
    type InboundTestRuntime,
    type InboundTestStorage
} from './inbound-runtime-test-fixture.ts';
import { ALWorkBatchTestObserver } from './work/al-work-batch-test-observer.ts';

import '../../setup-browser-indexeddb.ts';

type AdmissionOutcomeEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'admission-outcome'; }>;
type EffectDrainEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;
type RotationAliveEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'rotation-alive'; }>;
type ClaimSettledEvent = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'claim-settled'; }>;
type ReadInboundPendingAuthority = NonNullable<ALInboundMessageRuntime.Dependencies['readPendingAdmissionAuthority']>;

/** The clock step between two engine passes here: four passes, and four rotations, per liveness window. */
const ROTATION_PASS_STEP_MS = INBOX_OUTBOX_ENGINE_MAX_IDLE_MS / 4;
/** Passes enough for two liveness windows, so a missing event fails instead of polling on. */
const ROTATION_PASS_LIMIT = 8;
const DIAGNOSTICS_NAMESPACE = 'inbound-admission-diagnostics';
const DIAGNOSTICS_WORKER_ID = 'inbound-diagnostics-worker';

interface InboundDiagnosticsFixtureInput {
    readonly kind: InboundTestStorage;
    readonly plan?: (plan: ALMessageHandlingPlan) => ALMessageHandlingPlan;
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
    readonly dispatchOutcome?: 'completed' | 'retry';
    readonly readPendingAdmissionAuthority?: ReadInboundPendingAuthority;
    /** Absent leaves the batches unobserved; present, a stepped pass can wait for the batches it started. */
    readonly batches?: ALWorkBatchTestObserver;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function createRuntime(input: InboundDiagnosticsFixtureInput): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'rtc',
        stores: createInboundTestStores({
            namespace: DIAGNOSTICS_NAMESPACE,
            storage: input.kind,
            observer: createPassThroughIndexedDbOperationObserver()
        }),
        effectWorkerId: DIAGNOSTICS_WORKER_ID,
        canDispatchMessage: input.canDispatchMessage,
        plan: input.plan,
        dispatchOutcome: input.dispatchOutcome,
        readPendingAdmissionAuthority: input.readPendingAdmissionAuthority,
        acknowledgementCapture: input.batches === undefined
            ? undefined
            : { evidence: ALInboundAcknowledgementEvidence, batchObservations: input.batches.batchObservations }
    });
}

function admissionOutcomesOf(
    diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]
): readonly AdmissionOutcomeEvent[] {
    return diagnostics.filter((event): event is AdmissionOutcomeEvent => event.kind === 'admission-outcome');
}

function drainsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly EffectDrainEvent[] {
    return diagnostics.filter((event): event is EffectDrainEvent => event.kind === 'effect-drain');
}

function rotationsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly RotationAliveEvent[] {
    return diagnostics.filter((event): event is RotationAliveEvent => event.kind === 'rotation-alive');
}

function claimsOf(diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[]): readonly ClaimSettledEvent[] {
    return diagnostics.filter((event): event is ClaimSettledEvent => event.kind === 'claim-settled');
}

/** Installs a clock only the test moves, so a liveness window is crossed by stepping it. */
function useSteppedClock(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
}

/**
 * One engine pass `ROTATION_PASS_STEP_MS` after the last, once every batch started before it settled:
 * a pass that lands while a batch runs probes nothing, so each of these walks the rotation once.
 */
async function runSteppedPass(queueEngine: InboxOutboxEngine, batches: ALWorkBatchTestObserver): Promise<void> {
    await batches.waitForPublishedBatches();
    vi.setSystemTime(Date.now() + ROTATION_PASS_STEP_MS);
    await queueEngine.executeOnce();
    await batches.waitForPublishedBatches();
}

/** Runs bounded stepped passes until the rotation reports itself alive, so an absence can be read. */
async function runRotationUntilAlive(
    fixture: Pick<InboundTestRuntime, 'queueEngine' | 'diagnostics'>,
    batches: ALWorkBatchTestObserver
): Promise<void> {
    for (let pass = 0; pass < ROTATION_PASS_LIMIT && rotationsOf(fixture.diagnostics).length === 0; pass += 1) {
        await runSteppedPass(fixture.queueEngine, batches);
    }
}

it('types the trace and correlation of a claim as present together or null together', () => {
    const claim = {
        kind: 'claim-settled',
        lane: 'durable',
        workerId: DIAGNOSTICS_WORKER_ID,
        effectId: 'dispatch:sender:claimed',
        msgId: 'claimed',
        subjectMsgId: 'claimed',
        typeId: null,
        payloadKind: 'dispatch-local',
        durationMs: 0,
        attempts: 1,
        outcome: 'completed',
        queueWaitMs: 0,
        dueAtMs: 0,
        batchStartedAtMs: 0,
        startedAtMs: 0
    } as const;
    const untraced: ALInboundRuntimeDiagnosticsEvent = { ...claim, traceId: null, corrId: null };
    // @ts-expect-error A correlation without its trace is no claim a lane states.
    const halfTraced: ALInboundRuntimeDiagnosticsEvent = { ...claim, traceId: null, corrId: 'claimed' };

    expect([untraced, halfTraced].map((event) => event.kind)).toEqual(['claim-settled', 'claim-settled']);
});

it.each(['memory', 'indexeddb'] as const)(
    'names the message an ingress committed and the drain that delivered it over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind });
        const message = createInboundTestMessage({ msgId: 'committed-delivery', traceId: 'trace-committed-delivery' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            carrier: 'rtc',
            outcome: 'committed',
            reason: 'admitted',
            traceId: 'trace-committed-delivery',
            corrId: 'committed-delivery'
        }]);

        await expect.poll(() => delivered).toEqual(['dispatched']);
        // Only batches that touched work report; the rotation's empty rounds stay silent.
        const claimed = drainsOf(diagnostics);
        expect(claimed.map((event) => ({
            workerId: event.workerId,
            claimedCount: event.claimedCount,
            completedCount: event.completedCount,
            rescheduledCount: event.rescheduledCount,
            rejectedCount: event.rejectedCount
        }))).toEqual([{
            workerId: DIAGNOSTICS_WORKER_ID,
            claimedCount: 1,
            completedCount: 1,
            rescheduledCount: 0,
            rejectedCount: 0
        }]);

        // The one claim that drain ran, named: the delivery effect holds a reference to the message,
        // which carries its id and neither its type nor its trace.
        const settled = claimsOf(diagnostics);
        expect(settled.map((event) => ({
            kind: event.kind,
            workerId: event.workerId,
            msgId: event.msgId,
            typeId: event.typeId,
            payloadKind: event.payloadKind,
            attempts: event.attempts,
            outcome: event.outcome,
            traceId: event.traceId,
            corrId: event.corrId
        }))).toEqual([{
            kind: 'claim-settled',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: null,
            payloadKind: 'dispatch-local',
            attempts: 1,
            outcome: 'completed',
            traceId: null,
            corrId: null
        }]);
        expect(Object.keys(settled[0]!).slice(-2)).toEqual(['traceId', 'corrId']);

        // The batch's phases account for the claim it ran. Both read the same row's own wait, the
        // claim to its batch's run loop and the drain to the batch's own earlier start, so the
        // claim's is the longer by the batch's selection and reservation.
        const drain = claimed[0]!;
        expect(settled[0]?.durationMs).toBeLessThanOrEqual(drain.runDurationMs);
        expect(settled[0]?.batchStartedAtMs).toBe(drain.startedAtMs);
        expect(settled[0]?.queueWaitMs).toBeGreaterThanOrEqual(drain.queueWaitMs);
        expect(drain.selectionDurationMs + drain.claimDurationMs + drain.runDurationMs + drain.releaseDurationMs)
            .toBeLessThanOrEqual(drain.durationMs);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'splits a delivery wait into its reservation and intra-batch halves over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind });
        const message = createInboundTestMessage({ msgId: 'split-wait', acknowledged: true, traceId: 'trace-split-wait' });

        await runtime.ready();
        await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
        await expect.poll(() => delivered).toEqual(['dispatched']);
        await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(2);
        const dispatch = claimsOf(diagnostics).find((claim) => claim.payloadKind === 'dispatch-local')!;
        const control = claimsOf(diagnostics).find((claim) => claim.payloadKind === 'send-control')!;
        // The batch reports its drain after its last claim; wait for that event.
        await expect.poll(() => drainsOf(diagnostics).some((event) => event.startedAtMs === dispatch.batchStartedAtMs))
            .toBe(true);
        const drain = drainsOf(diagnostics).find((event) => event.startedAtMs === dispatch.batchStartedAtMs)!;
        expect(dispatch.effectId).toBe(`dispatch:${INBOUND_TEST_SENDER_PEER_ID}:${message.id.msgId}`);
        expect(dispatch.subjectMsgId).toBe(message.id.msgId);
        expect(control.subjectMsgId).toBe(message.id.msgId);
        expect(control.msgId).not.toBe(message.id.msgId);
        // The ACK the admission generated travels under the trace of the message it acknowledges.
        expect([control.traceId, control.corrId]).toEqual(['trace-split-wait', control.msgId]);
        expect(dispatch.dueAtMs).toBeLessThanOrEqual(dispatch.batchStartedAtMs);
        expect(dispatch.startedAtMs).toBeGreaterThanOrEqual(dispatch.batchStartedAtMs);
        expect(dispatch.queueWaitMs).toBe(Math.max(0, dispatch.batchStartedAtMs - dispatch.dueAtMs));
        // The dispatch runs ahead of its own ACK: on the durable lane page deliveries rank before control sends.
        expect(drain.claimedEffectIds).toEqual([dispatch.effectId, control.effectId]);
        expect(drain.deferred).toEqual([]);
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'settles the claim as a retry when the dispatch it ran asked for one over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({ kind, dispatchOutcome: 'retry' });

        await runtime.ready();
        await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'rescheduled-delivery' }),
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );
        await expect.poll(() => delivered).toEqual(['dispatched']);
        await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);

        // The batch reports its drain after its last claim; wait for that event.
        await expect.poll(() => drainsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
        // The row goes back to the queue, so the drain counts it rescheduled and the claim says why.
        expect(claimsOf(diagnostics)[0]?.outcome).toBe('retry');
        expect(drainsOf(diagnostics)[0]).toMatchObject({ claimedCount: 1, completedCount: 0, rescheduledCount: 1 });
    }
);

it.each(
    [
        ['not-ready', async () => ({ kind: 'retry', retryAfterMs: 60_000 }), []],
        [
            'non-retryable',
            async () => ({ kind: 'authorized', source: { kind: 'rtc-peer', peerId: 'impostor' } }),
            [{ outcome: 'unauthorized', reason: 'unauthorized' }]
        ],
        ['completed', async () => ({ kind: 'rejected' }), [{ outcome: 'unauthorized', reason: 'unauthorized' }]]
    ] as const satisfies readonly (readonly [string, ReadInboundPendingAuthority, readonly object[]])[]
)(
    'settles a retained admission as %s and names the message it replayed',
    async (outcome, readPendingAdmissionAuthority, replayVerdicts) => {
        const { runtime, stores, diagnostics } = createRuntime({
            kind: 'memory',
            readPendingAdmissionAuthority
        });
        const message = createInboundTestMessage({ msgId: `retained-${outcome}`, traceId: `trace-retained-${outcome}` });

        await runtime.ready();
        // Every attempt's write of the arrival is lost, so the claim settled is the retained admission's replay.
        const restoreWrites = setNextInboundAdmissionParked(stores.admissionStore);
        const admitted = await runtime.admitIncomingMessage(
            message,
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );

        expect(admitted.right).toEqual({ kind: 'pending-admission' });
        restoreWrites();
        await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);

        // A retained admission keeps the message itself, so this claim names both halves of its identity.
        expect(claimsOf(diagnostics)[0]).toMatchObject({
            kind: 'claim-settled',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            payloadKind: 'admit-message',
            attempts: 1,
            outcome,
            traceId: `trace-retained-${outcome}`,
            corrId: `retained-${outcome}`
        });
        // A retry is no verdict, so only the retention is stated; a refusal states its own verdict after it.
        expect(admissionOutcomesOf(diagnostics).map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
            { outcome: 'pending', reason: 'pending-admission' },
            ...replayVerdicts
        ]);
    }
);

it('an expired retained admission states rejected / expired once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const { runtime, stores, diagnostics, delivered } = createRuntime({
        kind: 'memory',
        // The replay's authority answers only after the retained deadline, the message's 60 s ttl, has passed.
        readPendingAdmissionAuthority: async (_msg, source) => {
            vi.setSystemTime(Date.now() + 60_000);
            return { kind: 'authorized', source };
        }
    });
    const message = createInboundTestMessage({ msgId: 'retained-expired', traceId: 'trace-retained-expired' });

    await runtime.ready();
    // Every attempt's write of the arrival is lost, so the expiry is met by the retained admission's replay.
    const restoreWrites = setNextInboundAdmissionParked(stores.admissionStore);
    const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });

    expect(admitted.right).toEqual({ kind: 'pending-admission' });
    restoreWrites();
    await expect.poll(() => claimsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
    expect(admissionOutcomesOf(diagnostics).map(({ workerId, msgId, outcome, reason, traceId }) => ({ workerId, msgId, outcome, reason, traceId })))
        .toEqual([
            { workerId: DIAGNOSTICS_WORKER_ID, msgId: 'retained-expired', outcome: 'pending', reason: 'pending-admission', traceId: 'trace-retained-expired' },
            { workerId: DIAGNOSTICS_WORKER_ID, msgId: 'retained-expired', outcome: 'rejected', reason: 'expired', traceId: 'trace-retained-expired' }
        ]);
    expect(delivered).toEqual([]);
});

it.each(['memory', 'indexeddb'] as const)(
    'names an unauthorized drop that writes nothing, sends no NACK and returns no error over %s',
    async (kind) => {
        const { runtime, diagnostics, delivered } = createRuntime({
            kind,
            plan: (plan) => ({
                ...plan,
                dropReason: 'unauthorized',
                dropReasonCode: 'unauthorized',
                localDelivery: { enabled: false, persist: false, deferred: false },
                nack: { enabled: false, reason: 'unauthorized', missingRanges: [] }
            })
        });
        const message = createInboundTestMessage({ msgId: 'unauthorized-drop', traceId: 'trace-unauthorized-drop' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });

        // Without this event the drop is indistinguishable from a delivery still on its way.
        expect(admitted.right).toEqual({ kind: 'not-admitted', reason: 'unauthorized' });
        expect(admissionOutcomesOf(diagnostics)).toEqual([{
            kind: 'admission-outcome',
            workerId: DIAGNOSTICS_WORKER_ID,
            msgId: message.id.msgId,
            typeId: 'chat.private-text.v1',
            carrier: 'rtc',
            outcome: 'unauthorized',
            reason: 'unauthorized',
            traceId: 'trace-unauthorized-drop',
            corrId: 'unauthorized-drop'
        }]);
        expect(delivered).toEqual([]);
    }
);

it('names a publication refusal unauthorized, its refusal code kept in the reason', async () => {
    const { runtime, diagnostics } = createRuntime({
        kind: 'memory',
        plan: (plan) => ({
            ...plan,
            dropReason: 'unauthorized: invalid-signature',
            dropReasonCode: 'unauthorized',
            localDelivery: { enabled: false, persist: false, deferred: false },
            nack: { enabled: false, reason: 'unauthorized', missingRanges: [] }
        })
    });

    await runtime.ready();
    await runtime.admitIncomingMessage(
        createInboundTestMessage({ msgId: 'publication-refusal' }),
        { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
    );

    expect(admissionOutcomesOf(diagnostics).map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
        { outcome: 'unauthorized', reason: 'unauthorized: invalid-signature' }
    ]);
});

it.each(['memory', 'indexeddb'] as const)(
    'emits no diagnostic that carries a payload resource, delivered or refused, over %s',
    async (kind) => {
        const delivering = createRuntime({ kind });
        const refusing = createRuntime({
            kind,
            plan: (plan) => ({ ...plan, dropReason: 'unauthorized: no-publish-grant', dropReasonCode: 'unauthorized' })
        });
        const message = createInboundTestMessage({ msgId: 'resource-carrier', traceId: 'trace-resource-carrier' });
        const secret: ALMessage = { ...message, payload: { ...message.payload, resource: '{"text":"payload-resource-secret"}' } };

        for (const { runtime } of [delivering, refusing]) {
            await runtime.ready();
            await runtime.admitIncomingMessage(secret, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
        }
        await expect.poll(() => delivering.delivered).toEqual(['dispatched']);

        const diagnostics = [...delivering.diagnostics, ...refusing.diagnostics];
        expect(admissionOutcomesOf(diagnostics).map((event) => event.outcome)).toEqual(['committed', 'unauthorized']);
        expect(JSON.stringify(diagnostics)).not.toContain('payload-resource-secret');
    }
);

it.each(['memory', 'indexeddb'] as const)(
    'separates a committed admission no consumer claims from one that was never admitted over %s',
    async (kind) => {
        useSteppedClock();
        const batches = new ALWorkBatchTestObserver();
        const { runtime, diagnostics, delivered, queueEngine } = createRuntime({
            kind,
            canDispatchMessage: () => false,
            batches
        });
        const message = createInboundTestMessage({ msgId: 'no-inbox-consumer' });

        await runtime.ready();
        const admitted = await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
        await runRotationUntilAlive({ queueEngine, diagnostics }, batches);

        expect(admitted.right).toEqual({ kind: 'admitted' });
        expect(admissionOutcomesOf(diagnostics).map((event) => event.outcome)).toEqual(['committed']);

        // The rotation walked over the committed row for a whole liveness window, so this is the absence
        // of a claim rather than the absence of a rotation: no drain ever selects the row while the
        // consumer is missing, and a batch that touched nothing reports nothing.
        expect(rotationsOf(diagnostics).length).toBeGreaterThanOrEqual(1);
        expect(delivered).toEqual([]);
        expect(drainsOf(diagnostics)).toEqual([]);
    },
    30_000
);

it('names a cleared row the port left unreserved in the drain that ran without it', async () => {
    const { runtime, stores, diagnostics, delivered } = createRuntime({ kind: 'memory' });
    const message = createInboundTestMessage({ msgId: 'port-unreserved', acknowledged: true });
    const reserveEntries = stores.workQueue.reserveEntries.bind(stores.workQueue);
    // The port reserves one observed row per batch, as when another owner took the rest first.
    vi.spyOn(stores.workQueue, 'reserveEntries').mockImplementation((input) =>
        reserveEntries({ ...input, observedEntries: input.observedEntries?.slice(0, 1) })
    );

    await runtime.ready();
    await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
    await expect.poll(() => drainsOf(diagnostics).length).toBeGreaterThanOrEqual(1);

    // The admission's commit ran one batch; the port reserved only the ACK row the page sorted first.
    // Both rows were written by the one admission at one instant, so they share a due time.
    const [control] = claimsOf(diagnostics);
    const [controlDrain] = drainsOf(diagnostics);
    expect(control?.payloadKind).toBe('send-control');
    expect(controlDrain?.claimedEffectIds).toEqual([control?.effectId]);
    expect(controlDrain?.deferred).toEqual([{
        effectId: `dispatch:${INBOUND_TEST_SENDER_PEER_ID}:${message.id.msgId}`,
        dueAtMs: control?.dueAtMs
    }]);
    expect(delivered).toEqual([]);
});

it.each(['memory', 'indexeddb'] as const)(
    'names the due row its rotations held back on the liveness event rather than one of its own over %s',
    async (kind) => {
        useSteppedClock();
        const batches = new ALWorkBatchTestObserver();
        const { runtime, diagnostics, queueEngine } = createRuntime({ kind, canDispatchMessage: () => false, batches });
        const message = createInboundTestMessage({ msgId: 'deferred-witness' });

        await runtime.ready();
        await runtime.admitIncomingMessage(message, { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID });
        await runRotationUntilAlive({ queueEngine, diagnostics }, batches);

        const rotation = rotationsOf(diagnostics)[0]!;
        expect(rotation.deferredRotationCount).toBeGreaterThan(0);
        expect(rotation.latestDeferred.map((deferred) => deferred.effectId)).toContain(
            `dispatch:${INBOUND_TEST_SENDER_PEER_ID}:${message.id.msgId}`
        );
        expect(drainsOf(diagnostics)).toEqual([]);
    },
    30_000
);

it.each(['memory', 'indexeddb'] as const)(
    'reports the rotation still running while it claims nothing, once per liveness window, over %s',
    async (kind) => {
        useSteppedClock();
        const batches = new ALWorkBatchTestObserver();
        const { runtime, diagnostics, queueEngine } = createRuntime({ kind, canDispatchMessage: () => false, batches });

        await runtime.ready();
        await runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'rotation-liveness' }),
            { kind: 'rtc-peer', peerId: INBOUND_TEST_SENDER_PEER_ID }
        );
        for (let pass = 0; pass < 3 * INBOX_OUTBOX_ENGINE_MAX_IDLE_MS / ROTATION_PASS_STEP_MS; pass += 1) {
            await runSteppedPass(queueEngine, batches);
        }

        // The witness that separates "no consumer is registered for this typeId" from "the rotation
        // stopped": the row is still there, still scanned, and still claimed by nobody. One event per
        // window, and every pass of a window walked one rotation from the head of NEW. The first pass
        // also finished the rotation the bootstrap read began, before the row was admitted, so the
        // first window holds one rotation more, and one that held nothing back.
        expect(rotationsOf(diagnostics).map((rotation) => [rotation.rotationCount, rotation.durationMs])).toEqual([
            [5, INBOX_OUTBOX_ENGINE_MAX_IDLE_MS],
            [4, INBOX_OUTBOX_ENGINE_MAX_IDLE_MS],
            [4, INBOX_OUTBOX_ENGINE_MAX_IDLE_MS]
        ]);
        expect(rotationsOf(diagnostics).map((rotation) => rotation.deferredRotationCount)).toEqual([4, 4, 4]);
        expect(rotationsOf(diagnostics)[0]).toMatchObject({ kind: 'rotation-alive', workerId: DIAGNOSTICS_WORKER_ID });
        // The slowest single rotation of each window: a rotation that crawls says so without stopping.
        for (const rotation of rotationsOf(diagnostics)) {
            expect(rotation.longestRotationReadMs).toBeLessThanOrEqual(rotation.durationMs);
        }
        expect(drainsOf(diagnostics)).toEqual([]);
    },
    30_000
);
