import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundRuntimeStores,
    ALOutboundSettledSendResult
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    createVolatileOutboundTestStores,
    enqueueOutboundOrThrow,
    holdOutboundClaims,
    peekOutboundWorkReadyAt,
    readOutboundTestAdmission,
    runOutboundWorkTask,
    toOutboundTestAck,
    trackOutboundTestAcks,
    waitUntil
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

const PREPARED: OutboundTestPayload = { kind: 'send' };
const BACKEND_KINDS = ['memory', 'indexeddb'] as const;
/** Short enough that the acknowledgement row falls due inside the test, long enough to stay valid. */
const ACK_TIMEOUT_WINDOW_MS = 50;
/** Longer than 100 nominal retry windows, still inside the message's original deadline. */
const ACK_TIMEOUT_DOWNTIME_MS = 8_000;

afterEach(() => {
    vi.restoreAllMocks();
});

function createStores(kind: 'memory' | 'indexeddb'): ALOutboundRuntimeStores<OutboundTestPayload> {
    const backend = kind === 'memory'
        ? new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now)
        : new IndexedDbAdmissionBackend({
            schemaId: AL_ADMISSION_SCHEMA_ID,
            onStorageReset: () => {},
            dbName: `outbound-settlements-${crypto.randomUUID()}`,
            storeName: 'entries',
            nowMs: Date.now,
            newWriteToken: crypto.randomUUID.bind(crypto),
            observer: createPassThroughIndexedDbOperationObserver()
        });
    const admissionStore = createALOutboundAdmissionStore({
        nowMs: Date.now,
        canonicalScope: 'outbound-settlements',
        decodePrepared: decodeOutboundTestPayload,
        namespace: 'outbound-settlements',
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    return { admissionStore, workQueue: backend.workQueue };
}

function planSend(
    ackTracking?: ALOutboundAckTrackingPlan
): (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReasonCode: undefined,
        lane: 'durable',
        preparedMessages: [PREPARED],
        ackTracking,
        admittedConnectionGenerationIds: undefined
    });
}

function planSupersedingSend(): (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload> {
    return (msg) => ({
        ...planSend()(msg),
        supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'lifecycle-slot' }
    });
}

/** The lifecycle a registry holds for a message its owner admitted with one queued attempt. */
function toQueuedLifecycle(message: ALMessage): ALDeliveryLifecycle {
    return computeALDeliveryLifecycle(
        createInitialALDeliveryLifecycle({
            msgId: message.id.msgId,
            typeId: message.payload.typeId,
            ackMode: 'receiver',
            receiptAlgo: 'receiver',
            expiresAtMs: undefined,
            submittedAtMs: 0
        }),
        {
            kind: 'admission',
            msgId: message.id.msgId,
            carrier: 'ws',
            atMs: 0,
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 },
            trackedReceiptAlgo: 'receiver',
            traceId: 'trace-outbound-delivery-settlements'
        }
    );
}

// The browser relays a durable lane's settlement to the tab that holds the message; a volatile message's
// state stays in the tab that admitted it, and a cancel is the runtime's own.
it('stamps every settlement with the lane that stated it, and its own cancel with none', async () => {
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores('memory'),
        volatileStores: createVolatileOutboundTestStores(),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            ...planSend()(msg),
            lane: msg.route.resourceId === 'msg-durable-lane' ? 'durable' : 'volatile'
        }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const durable = createOutboundMessage('msg-durable-lane');
    const volatile = createOutboundMessage('msg-volatile-lane');

    await enqueueOutboundOrThrow(runtime, durable);
    await enqueueOutboundOrThrow(runtime, volatile);
    runtime.cancel('msg-never-admitted', 'trace-cancel-never-admitted');

    const lanesOf = (msgId: string) => settlements.filter((settlement) => settlement.msgId === msgId).map(({ lane }) => lane);
    expect(lanesOf(durable.id.msgId)).toEqual(['durable', 'durable']);
    expect(lanesOf(volatile.id.msgId)).toEqual(['volatile', 'volatile']);
    expect(settlements.filter((settlement) => settlement.msgId === 'msg-never-admitted')).toStrictEqual([
        { kind: 'cancelled', msgId: 'msg-never-admitted', traceId: 'trace-cancel-never-admitted', carrier: 'ws', atMs: expect.any(Number) }
    ]);
});

it.each(BACKEND_KINDS)(
    'states the attempt it started and the outcome its carrier settled over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind),
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend(),
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createOutboundMessage('msg-settled-sent', { traceId: 'trace-settled-sent' });

        await enqueueOutboundOrThrow(runtime, message);

        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);
        expect(settlements.map((settlement) => settlement.traceId)).toEqual(['trace-settled-sent', 'trace-settled-sent']);
        expect(settlements[0]).toMatchObject({
            kind: 'attempt-started',
            msgId: message.id.msgId,
            carrier: 'ws',
            attemptId: expect.any(String)
        });
        expect(settlements[1]).toMatchObject({
            kind: 'attempt-settled',
            msgId: message.id.msgId,
            carrier: 'ws',
            attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
            outcome: 'sent',
            submissionAttempted: true,
            willRetry: false
        });
        expect(settlements[0]?.atMs).toBeGreaterThan(0);
    }
);

it.each(BACKEND_KINDS)('states that a not-ready attempt will be tried again over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores(kind),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async () => ({
            status: 'not-ready',
            submissionAttempted: false,
            reason: 'No carrier lane yet',
            retryAfterMs: 50
        })
    });
    const message = createOutboundMessage('msg-settled-not-ready', { traceId: 'trace-settled-not-ready' });

    await enqueueOutboundOrThrow(runtime, message);

    expect(settlements.filter((settlement) => settlement.kind === 'attempt-settled')).toEqual([{
        kind: 'attempt-settled',
        msgId: message.id.msgId,
        carrier: 'ws',
        lane: 'durable',
        atMs: expect.any(Number),
        attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'No carrier lane yet',
        willRetry: true,
        traceId: 'trace-settled-not-ready'
    }]);
});

it.each(BACKEND_KINDS)('states a retained attempt only when its carrier settles it over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const settled = Promise.withResolvers<ALOutboundSettledSendResult>();
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores(kind),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async () => ({ status: 'queued', settled: settled.promise })
    });
    onTestFinished(() => settled.resolve({ status: 'cancelled', submissionAttempted: false }));
    const message = createOutboundMessage('msg-settled-retained');

    await enqueueOutboundOrThrow(runtime, message);

    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started']);

    settled.resolve({ status: 'sent', submissionAttempted: true, reason: 'Handed to the native queue' });
    await waitUntil(() => settlements.length === 2);

    expect(settlements[1]).toMatchObject({
        kind: 'attempt-settled',
        msgId: message.id.msgId,
        attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
        outcome: 'sent',
        submissionAttempted: true,
        detail: 'Handed to the native queue',
        willRetry: false
    });
});

it.each(BACKEND_KINDS)('states the peers an accepted acknowledgement confirms over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores(kind),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(trackOutboundTestAcks(['peer-1', 'peer-2'])),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const message = createOutboundMessage('msg-acknowledged');
    await enqueueOutboundOrThrow(runtime, message);

    for (const fromPeerId of ['peer-1', 'peer-2']) {
        const admitted = await runtime.acceptControlMessage(toOutboundTestAck(message, fromPeerId), 'peer');
        expect(admitted.kind).toBe('committed');
    }

    expect(settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
        {
            kind: 'acknowledgement',
            msgId: message.id.msgId,
            carrier: 'ws',
            lane: 'durable',
            atMs: expect.any(Number),
            mode: 'hop',
            confirmedHopPeerIds: ['peer-1'],
            unconfirmedHopPeerIds: ['peer-2'],
            expectedRecipientPeerIds: ['peer-1', 'peer-2'],
            confirmedRecipientPeerIds: ['peer-1'],
            unconfirmedRecipientPeerIds: ['peer-2'],
            complete: false,
            traceId: 'trace-outbound-runtime-test-fixture'
        },
        {
            kind: 'acknowledgement',
            msgId: message.id.msgId,
            carrier: 'ws',
            lane: 'durable',
            atMs: expect.any(Number),
            mode: 'hop',
            confirmedHopPeerIds: ['peer-1', 'peer-2'],
            unconfirmedHopPeerIds: [],
            expectedRecipientPeerIds: ['peer-1', 'peer-2'],
            confirmedRecipientPeerIds: ['peer-1', 'peer-2'],
            unconfirmedRecipientPeerIds: [],
            complete: true,
            traceId: 'trace-outbound-runtime-test-fixture'
        }
    ]);
});

it.each(BACKEND_KINDS)(
    'settles a retained send its relay refuses with a resync-required NACK as rejected by that relay, with no resend, over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind),
            carrier: 'rtc',
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend({ ...trackOutboundTestAcks(['peer-1']), timeoutMs: ACK_TIMEOUT_WINDOW_MS }),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.kind));
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('msg-relay-resync');
        await enqueueOutboundOrThrow(runtime, message);
        const settledBefore = settlements.length;

        const admitted = await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 4, msgId: 'control-resync', ts: 1, senderId: 'peer-1', traceId: 'trace-outbound-delivery-settlements' },
                {
                    msgId: message.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'resync-required',
                    observedAtEpochMs: 1
                }
            ),
            'peer'
        );
        // Past two acknowledgement windows: a receipt the rejection left open would be retried by now.
        await new Promise((resolve) => setTimeout(resolve, 2 * ACK_TIMEOUT_WINDOW_MS + 30));
        await runOutboundWorkTask(runtime);
        await runOutboundWorkTask(runtime);

        expect(admitted.kind).toBe('committed');
        expect(settlements.slice(settledBefore)).toEqual([{
            kind: 'relay-rejected',
            msgId: message.id.msgId,
            carrier: 'rtc',
            lane: 'durable',
            atMs: expect.any(Number),
            relayRejection: { relay: 'peer', peerId: 'peer-1', reason: 'resync-required' },
            detail: 'Hop peer-1 refused the message: resync-required.',
            traceId: 'trace-outbound-delivery-settlements'
        }]);
        const lifecycle = settlements.reduce(computeALDeliveryLifecycle, toQueuedLifecycle(message));
        expect(lifecycle.state).toBe('rejected');
        expect(lifecycle.evidence.relayRejection).toEqual({ relay: 'peer', peerId: 'peer-1', reason: 'resync-required' });
        expect(sent).toEqual(['send']);
    }
);

it.each(BACKEND_KINDS)('states expiry for work claimed past its own deadline over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const claims = holdOutboundClaims(stores);
    let ownerNowMs = Date.now();
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        nowMs: () => ownerNowMs,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async (prepared) => {
            sent.push(String(prepared.kind));
            return { status: 'sent', submissionAttempted: true };
        }
    });
    const message = createOutboundMessage('msg-claimed-past-deadline', { ttlMs: 1_000, traceId: 'trace-claimed-past-deadline' });

    await runtime.enqueueIfAbsent(message);
    // The owner's clock passes the message deadline while its work is still unclaimed.
    ownerNowMs = Date.now() + 5_000;
    await claims.release(runtime);
    await runOutboundWorkTask(runtime);

    // Expiry alone: an attempt that ran would have stated `attempt-started` before its carrier.
    expect(sent).toEqual([]);
    expect(settlements).toEqual([{
        kind: 'expired',
        msgId: message.id.msgId,
        carrier: 'ws',
        lane: 'durable',
        atMs: ownerNowMs,
        detail: expect.any(String),
        traceId: 'trace-claimed-past-deadline'
    }]);
});

it.each(BACKEND_KINDS)('states the verdict a retained admission replay reached over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const store = stores.admissionStore;
    const competitor = await readOutboundTestAdmission({
        store: store,
        message: createOutboundMessage('competing-sender-version'),
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() }
    });
    const commitBundle = store.commitBundle.bind(store);
    let contested = false;
    // A competing sender wins the version fence inside the first commit, so the send below is told
    // its bundle conflicted and retains a pending admission the drain replays on its own.
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
        if (!contested) {
            contested = true;
            expect(await commitBundle(competitor)).toBe('committed');
        }
        return await commitBundle(bundle);
    });
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const message = createOutboundMessage('msg-retained-admission');

    const pending = await runtime.enqueueIfAbsent(message);
    expect(pending.verdict).toEqual({ kind: 'pending' });
    await expect.poll(async () => {
        await runOutboundWorkTask(runtime);
        return settlements.filter((settlement) => settlement.kind === 'admission').length;
    }).toBeGreaterThan(0);

    expect(settlements.filter((settlement) => settlement.kind === 'admission')[0]).toMatchObject({
        kind: 'admission',
        msgId: message.id.msgId,
        carrier: 'ws',
        verdict: { kind: 'admitted' }
    });
});

it.each(BACKEND_KINDS)('states the old message superseded when its replacement commits over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const held = holdOutboundClaims(stores);
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        // A supplied engine is never started, so only this test's batches ask the held queue for work.
        queueEngine: new InboxOutboxEngine(),
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSupersedingSend(),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const old = createOutboundMessage('msg-superseded-old', { traceId: 'trace-superseded-old' });
    const replacement = createOutboundMessage('msg-superseded-replacement', { traceId: 'trace-superseded-replacement' });

    await enqueueOutboundOrThrow(runtime, old);
    await enqueueOutboundOrThrow(runtime, replacement);

    // No claim has run: the drain is held, so only the replacement's commit can have said it.
    expect(settlements.filter((settlement) => settlement.msgId === old.id.msgId)).toEqual([
        expect.objectContaining({
            kind: 'superseded',
            replacementMsgId: replacement.id.msgId,
            traceId: 'trace-superseded-replacement'
        })
    ]);
    await held.release(runtime);
    await expect.poll(async () => {
        await runOutboundWorkTask(runtime);
        return settlements.some((settlement) => settlement.msgId === old.id.msgId && settlement.kind === 'attempt-settled');
    }).toBe(true);

    const oldSettlements = settlements.filter((settlement) => settlement.msgId === old.id.msgId);
    expect(oldSettlements).toEqual([
        expect.objectContaining({ kind: 'superseded', traceId: 'trace-superseded-replacement' }),
        expect.objectContaining({ kind: 'attempt-started', traceId: 'trace-superseded-old' }),
        expect.objectContaining({ kind: 'attempt-settled', outcome: 'superseded', traceId: 'trace-superseded-old' })
    ]);
    const lifecycle = oldSettlements.reduce(computeALDeliveryLifecycle, toQueuedLifecycle(old));
    expect(lifecycle.state).toBe('superseded');
    expect(lifecycle.evidence.reason).toBe('A newer message replaced this one at its admission.');
    expect(lifecycle.lateSettlementCount).toBe(2);
});

it.each(BACKEND_KINDS)('states the old message superseded at its replacement\'s replayed admission over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const store = stores.admissionStore;
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSupersedingSend(),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const old = createOutboundMessage('msg-superseded-before-replay');
    const replacement = createOutboundMessage('msg-replayed-replacement');
    await enqueueOutboundOrThrow(runtime, old);
    const competitor = await readOutboundTestAdmission({
        store: store,
        message: createOutboundMessage('competing-replay-version'),
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: () => Date.now() }
    });
    const commitBundle = store.commitBundle.bind(store);
    let contested = false;
    // The replacement's own commit loses the sender's version fence, so its admission waits for the replay.
    vi.spyOn(store, 'commitBundle').mockImplementation(async (bundle) => {
        if (!contested) {
            contested = true;
            expect(await commitBundle(competitor)).toBe('committed');
        }
        return await commitBundle(bundle);
    });

    expect((await runtime.enqueueIfAbsent(replacement)).verdict).toEqual({ kind: 'pending' });
    expect(settlements.filter((settlement) => settlement.kind === 'superseded')).toEqual([]);
    await expect.poll(async () => {
        await runOutboundWorkTask(runtime);
        return settlements.filter((settlement) => settlement.msgId === replacement.id.msgId).length;
    }).toBeGreaterThan(0);

    // Stated inside the replay's commit, which returns before the owner states the replayed verdict.
    const admittedAt = settlements.findIndex((settlement) => settlement.kind === 'admission' && settlement.msgId === replacement.id.msgId);
    expect(settlements.filter((settlement) => settlement.kind === 'superseded')).toEqual([
        expect.objectContaining({ msgId: old.id.msgId, replacementMsgId: replacement.id.msgId })
    ]);
    expect(settlements[admittedAt - 1]).toMatchObject({ kind: 'superseded', msgId: old.id.msgId });
});

it.each(BACKEND_KINDS)('drains the same work when the settlement sink throws over %s', async (kind) => {
    const stores = createStores(kind);
    const reported: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...entry) => {
        reported.push(String(entry[0]));
    });
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: () => {
            throw new Error('Settlement sink failed');
        },
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async (prepared) => {
            sent.push(String(prepared.kind));
            return { status: 'sent', submissionAttempted: true };
        }
    });
    const message = createOutboundMessage('msg-throwing-sink');

    await enqueueOutboundOrThrow(runtime, message);

    expect(sent).toEqual(['send']);
    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
    expect(reported).toContain('AL outbound delivery settlement sink failed');
});

it.each(BACKEND_KINDS)('admits the replacement when the sink throws on its superseded settlement over %s', async (kind) => {
    const stores = createStores(kind);
    const reported: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...entry) => {
        reported.push(String(entry[0]));
    });
    const superseded: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        queueEngine: new InboxOutboxEngine(),
        settlements: (settlement) => {
            if (settlement.kind === 'superseded') {
                superseded.push(settlement.msgId);
                throw new Error('Settlement sink failed');
            }
        },
        planOutgoingMessage: planSupersedingSend(),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const old = createOutboundMessage('msg-throwing-sink-old');
    const replacement = createOutboundMessage('msg-throwing-sink-replacement');
    await runtime.enqueueIfAbsent(old);

    const admitted = await runtime.enqueueIfAbsent(replacement);

    expect(superseded).toEqual([old.id.msgId]);
    expect(admitted.verdict).toEqual({ kind: 'admitted', durable: true, queuedAttempts: 1 });
    expect(await stores.admissionStore.readMessageSupersedence([old, replacement])).toEqual([
        { status: 'fulfilled', value: true },
        { status: 'fulfilled', value: false }
    ]);
    expect(reported).toEqual(['AL outbound delivery settlement sink failed']);
});

it.each(BACKEND_KINDS)('ends the attempt it started when the carrier throws over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async () => {
            throw new Error('WS connection dropped mid-send');
        }
    });
    const message = createOutboundMessage('msg-throwing-carrier');

    await runtime.enqueueIfAbsent(message);
    await runOutboundWorkTask(runtime);

    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);
    expect(settlements[1]).toMatchObject({
        kind: 'attempt-settled',
        msgId: message.id.msgId,
        attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
        outcome: 'failed',
        submissionAttempted: false,
        detail: 'WS connection dropped mid-send',
        willRetry: true
    });
    // The work handler still saw the throw: the row is retained for another attempt, not completed.
    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeDefined();
});

/**
 * A delayed timeout spends one actual retry, not every nominal window elapsed during downtime.
 * The queue serves the due row on its own clock; the owner's advanced clock schedules the next one.
 */
it('retries an overdue receipt without expiring the message while attempts remain', async () => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores('memory');
    let ownerNowMs = Date.now();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        // An engine this test owns and never starts: only the explicit batches below claim work.
        queueEngine: new InboxOutboxEngine(),
        nowMs: () => ownerNowMs,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend({
            enabled: true,
            timeoutMs: ACK_TIMEOUT_WINDOW_MS,
            maxAttempts: 100,
            expectedPeerIds: ['peer-1'],
            nextHopPeerIds: ['peer-1'],
            mode: 'hop'
        }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });

    const message = createOutboundMessage('msg-ack-timeout-budget');
    await enqueueOutboundOrThrow(runtime, message);
    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);

    // The timeout falls due on the queue's clock while the owner resumes after several windows.
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_WINDOW_MS + 30));
    ownerNowMs = Date.now() + ACK_TIMEOUT_DOWNTIME_MS;
    await runOutboundWorkTask(runtime);

    expect(
        await stores.admissionStore.readPendingAck({
            originPeerId: message.id.senderId,
            msgId: message.id.msgId
        })
    ).toMatchObject({ attempts: 1, maxAttempts: 100 });
    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);
});

it.each(BACKEND_KINDS)(
    'states the carrier outcome and then the deadline that ended the message over %s',
    async (kind) => {
        const sent = await readSettlementsPastDeadline(kind, { status: 'sent', submissionAttempted: true });
        expect(sent.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled', 'expired']);
        expect(sent[1]).toMatchObject({ outcome: 'sent', submissionAttempted: true, willRetry: false });

        // `not-ready` with `willRetry: false` has no meaning: the expiry is the whole fact.
        const notReady = await readSettlementsPastDeadline(kind, {
            status: 'not-ready',
            submissionAttempted: false,
            retryAfterMs: 50
        });
        expect(notReady.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'expired']);

        const failed = await readSettlementsPastDeadline(kind, { status: 'failed', submissionAttempted: true });
        expect(failed.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled', 'expired']);
        expect(failed[1]).toMatchObject({ outcome: 'failed', submissionAttempted: true, willRetry: false });
    }
);

it.each(BACKEND_KINDS)(
    'completes a claimed send-prepared effect without sending when cancelled before the drain over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const sent: string[] = [];
        const stores = createStores(kind);
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend(),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.kind));
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('msg-cancelled-before-drain', { traceId: 'trace-cancelled-before-drain' });

        // The owner has admitted no work for this id yet; the cancellation is still remembered.
        expect(runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        expect(runtime.cancel(message.id.msgId, message.id.traceId)).toBe('already-cancelled');

        await runtime.enqueueIfAbsent(message);
        await runOutboundWorkTask(runtime);

        expect(sent).toEqual([]);
        expect(settlements).toEqual([{
            kind: 'cancelled',
            msgId: message.id.msgId,
            carrier: 'ws',
            atMs: expect.any(Number),
            traceId: 'trace-cancelled-before-drain'
        }]);
        expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
    }
);

it.each(BACKEND_KINDS)(
    'cancels a retained send: aborts its signal and the transport settles cancelled over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const settled = Promise.withResolvers<ALOutboundSettledSendResult>();
        let capturedSignal: AbortSignal | undefined;
        const stores = createStores(kind);
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend(),
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                capturedSignal = lifecycle.signal;
                return { status: 'queued', settled: settled.promise };
            }
        });
        onTestFinished(() => settled.resolve({ status: 'cancelled', submissionAttempted: false }));
        const message = createOutboundMessage('msg-cancel-retained');

        await enqueueOutboundOrThrow(runtime, message);
        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started']);
        expect(capturedSignal?.aborted).toBe(false);

        expect(runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');

        expect(capturedSignal?.aborted).toBe(true);
        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'cancelled']);

        settled.resolve({ status: 'cancelled', submissionAttempted: false, reason: 'Aborted by cancel().' });
        await waitUntil(() => settlements.length === 3);

        expect(settlements[2]).toMatchObject({
            kind: 'attempt-settled',
            msgId: message.id.msgId,
            attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
            outcome: 'cancelled',
            submissionAttempted: false,
            willRetry: false
        });

        // The row was released `completed`: a further batch finds no work left to attempt.
        await runOutboundWorkTask(runtime);
        expect(settlements.length).toBe(3);
    }
);

it.each(BACKEND_KINDS)(
    'cancels an attempt still inside its pre-transport reads: no transport call, one settlement pair over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const sent: string[] = [];
        const stores = createStores(kind);
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend(),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.kind));
                return { status: 'sent', submissionAttempted: true };
            }
        });
        const message = createOutboundMessage('msg-cancelled-pre-transport');
        // The abort lands mid-await, inside `writeAttemptedSend`'s own read -- before its carrier runs.
        const readSendGuards = stores.admissionStore.readSendGuards.bind(stores.admissionStore);
        vi.spyOn(stores.admissionStore, 'readSendGuards').mockImplementationOnce(async (sent) => {
            runtime.cancel(sent.id.msgId, sent.id.traceId);
            return await readSendGuards(sent);
        });

        await enqueueOutboundOrThrow(runtime, message);

        expect(sent).toEqual([]);
        expect(settlements.map((settlement) => settlement.kind)).toEqual([
            'attempt-started',
            'cancelled',
            'attempt-settled'
        ]);
        expect(settlements[2]).toMatchObject({
            kind: 'attempt-settled',
            msgId: message.id.msgId,
            attemptId: settlements.find((settlement) => settlement.kind === 'attempt-started')?.attemptId,
            outcome: 'cancelled',
            submissionAttempted: false,
            detail: 'The message was cancelled before its carrier ran.',
            willRetry: false
        });
    }
);

it.each(BACKEND_KINDS)(
    'disposes every live per-message signal without stating a cancelled settlement over %s',
    async (kind) => {
        const settlements: ALDeliverySettlement[] = [];
        const settledByMsgId = new Map<string, PromiseWithResolvers<ALOutboundSettledSendResult>>();
        const signalByMsgId = new Map<string, AbortSignal>();
        const runtime = createDefaultOutboundTestRuntime({
            stores: createStores(kind),
            settlements: (settlement) => settlements.push(settlement),
            planOutgoingMessage: planSend(),
            sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
                const msgId = lifecycle.canonicalMessage.id.msgId;
                const settled = Promise.withResolvers<ALOutboundSettledSendResult>();
                settledByMsgId.set(msgId, settled);
                signalByMsgId.set(msgId, lifecycle.signal);
                return { status: 'queued', settled: settled.promise };
            }
        });
        onTestFinished(() => {
            for (const settled of settledByMsgId.values()) {
                settled.resolve({ status: 'cancelled', submissionAttempted: false });
            }
        });
        // Two independent messages: disposal must reach both controllers, not just one shared signal.
        const first = createOutboundMessage('msg-dispose-live-signal-1');
        const second = createOutboundMessage('msg-dispose-live-signal-2');

        await enqueueOutboundOrThrow(runtime, first);
        await enqueueOutboundOrThrow(runtime, second);
        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-started']);

        const disposing = runtime.dispose();

        expect(signalByMsgId.get(first.id.msgId)?.aborted).toBe(true);
        expect(signalByMsgId.get(second.id.msgId)?.aborted).toBe(true);
        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-started']);

        settledByMsgId.get(first.id.msgId)?.resolve({ status: 'cancelled', submissionAttempted: false });
        settledByMsgId.get(second.id.msgId)?.resolve({ status: 'cancelled', submissionAttempted: false });
        await disposing;
        await waitUntil(() => settlements.length === 4);

        // Both attempts settle cancelled; the owner itself states no `cancelled` fact for a disposed message.
        expect(settlements.map((settlement) => settlement.kind)).toEqual([
            'attempt-started',
            'attempt-started',
            'attempt-settled',
            'attempt-settled'
        ]);
        expect(settlements[2]).toMatchObject({ outcome: 'cancelled', willRetry: false });
        expect(settlements[3]).toMatchObject({ outcome: 'cancelled', willRetry: false });
    }
);

it('completes an ack-timeout effect for a cancelled message without retrying it', async () => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores('memory');
    let ownerNowMs = Date.now();
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        // An engine this test owns and never starts: only the explicit batches below claim work.
        queueEngine: new InboxOutboxEngine(),
        nowMs: () => ownerNowMs,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend({
            enabled: true,
            timeoutMs: ACK_TIMEOUT_WINDOW_MS,
            maxAttempts: 100,
            expectedPeerIds: ['peer-1'],
            nextHopPeerIds: ['peer-1'],
            mode: 'hop'
        }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const message = createOutboundMessage('msg-cancelled-ack-timeout');

    await enqueueOutboundOrThrow(runtime, message);
    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);

    expect(runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');

    // The acknowledgement row falls due on the queue's clock; cancellation preempts its repair.
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_WINDOW_MS + 30));
    ownerNowMs = Date.now();
    await runOutboundWorkTask(runtime);

    expect(settlements.map((settlement) => settlement.kind)).toEqual([
        'attempt-started',
        'attempt-settled',
        'cancelled'
    ]);
    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
});

/** Drains one message whose deadline passes inside its carrier, so the deadline guard settles it. */
async function readSettlementsPastDeadline(
    kind: 'memory' | 'indexeddb',
    settled: ALOutboundSettledSendResult
): Promise<readonly ALDeliverySettlement[]> {
    const settlements: ALDeliverySettlement[] = [];
    let ownerNowMs = Date.now();
    const runtime = createDefaultOutboundTestRuntime({
        stores: createStores(kind),
        nowMs: () => ownerNowMs,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: planSend(),
        sendPreparedMessage: async () => {
            ownerNowMs = Date.now() + 60_000;
            return settled;
        }
    });

    await enqueueOutboundOrThrow(runtime, createOutboundMessage(`msg-past-deadline-${settled.status}`));

    return settlements;
}
