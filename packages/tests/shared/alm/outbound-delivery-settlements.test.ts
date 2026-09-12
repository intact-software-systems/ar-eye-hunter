import { afterEach, expect, it, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundDispatchPlan,
    ALOutboundRuntimeStores,
    ALOutboundSettledSendResult
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import '../../setup-browser-indexeddb.ts';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    holdOutboundClaims,
    peekOutboundWorkReadyAt,
    runOutboundWorkTask,
    waitUntil
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

const PREPARED: OutboundTestPayload = { kind: 'send' };
const BACKEND_KINDS = ['memory', 'indexeddb'] as const;
/** Short enough that the acknowledgement row falls due inside the test, long enough to stay valid. */
const ACK_TIMEOUT_WINDOW_MS = 50;
/** Past the row's own retention budget (`deadlineAtMs + timeoutMs * 101`), inside the message TTL. */
const ACK_TIMEOUT_BUDGET_OVERSHOOT_MS = 8_000;

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

/** The identity the admission commits for a first immediate attempt on one prepared copy. */
function firstAttemptId(msgId: string): string {
    return toALOutboundEffectId([
        'send',
        msgId,
        'immediate',
        'initial',
        0,
        toALOutboundPreparedFingerprint(PREPARED)
    ]);
}

function planSend(
    ackTracking?: ALOutboundAckTrackingPlan
): (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [PREPARED],
        ackTracking
    });
}

function trackAcks(expectedPeerIds: readonly string[]): ALOutboundAckTrackingPlan {
    return { enabled: true, timeoutMs: 60_000, maxAttempts: 3, expectedPeerIds };
}

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
        const message = createOutboundMessage('msg-settled-sent');

        await enqueueOutboundOrThrow(runtime, message);

        expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);
        expect(settlements[0]).toMatchObject({
            kind: 'attempt-started',
            msgId: message.id.msgId,
            carrier: 'ws',
            attemptId: firstAttemptId(message.id.msgId)
        });
        expect(settlements[1]).toMatchObject({
            kind: 'attempt-settled',
            msgId: message.id.msgId,
            carrier: 'ws',
            attemptId: firstAttemptId(message.id.msgId),
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
    const message = createOutboundMessage('msg-settled-not-ready');

    await enqueueOutboundOrThrow(runtime, message);

    expect(settlements.filter((settlement) => settlement.kind === 'attempt-settled')).toEqual([{
        kind: 'attempt-settled',
        msgId: message.id.msgId,
        carrier: 'ws',
        atMs: expect.any(Number),
        attemptId: firstAttemptId(message.id.msgId),
        outcome: 'not-ready',
        submissionAttempted: false,
        detail: 'No carrier lane yet',
        willRetry: true
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
    const message = createOutboundMessage('msg-settled-retained');

    await enqueueOutboundOrThrow(runtime, message);

    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started']);

    settled.resolve({ status: 'sent', submissionAttempted: true, reason: 'Handed to the native queue' });
    await waitUntil(() => settlements.length === 2);

    expect(settlements[1]).toMatchObject({
        kind: 'attempt-settled',
        msgId: message.id.msgId,
        attemptId: firstAttemptId(message.id.msgId),
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
        planOutgoingMessage: planSend(trackAcks(['peer-1', 'peer-2'])),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });
    const message = createOutboundMessage('msg-acknowledged');
    await enqueueOutboundOrThrow(runtime, message);

    for (const fromPeerId of ['peer-1', 'peer-2']) {
        const admitted = await runtime.acceptControlMessage(newALAckControlMessage(
            { v: 2, msgId: `control-${fromPeerId}`, ts: 1, senderId: fromPeerId },
            {
                ackedMsgId: message.id.msgId,
                fromPeerId,
                toPeerId: 'self',
                status: 'accepted',
                observedAtEpochMs: 1
            }
        ));
        expect(admitted.kind).toBe('committed');
    }

    expect(settlements.filter((settlement) => settlement.kind === 'acknowledgement')).toEqual([
        {
            kind: 'acknowledgement',
            msgId: message.id.msgId,
            carrier: 'ws',
            atMs: expect.any(Number),
            confirmedHopPeerIds: ['peer-1'],
            unconfirmedHopPeerIds: ['peer-2'],
            complete: false
        },
        {
            kind: 'acknowledgement',
            msgId: message.id.msgId,
            carrier: 'ws',
            atMs: expect.any(Number),
            confirmedHopPeerIds: ['peer-1', 'peer-2'],
            unconfirmedHopPeerIds: [],
            complete: true
        }
    ]);
});

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
    const message = createOutboundMessage('msg-claimed-past-deadline', { ttlMs: 1_000 });

    await runtime.enqueueIfAbsent(message);
    // The owner's clock passes the message deadline while its work is still unclaimed.
    ownerNowMs = Date.now() + 5_000;
    await claims.release();
    await runOutboundWorkTask(runtime);

    // Expiry alone: an attempt that ran would have stated `attempt-started` before its carrier.
    expect(sent).toEqual([]);
    expect(settlements).toEqual([{
        kind: 'expired',
        msgId: message.id.msgId,
        carrier: 'ws',
        atMs: ownerNowMs,
        detail: expect.any(String)
    }]);
});

it.each(BACKEND_KINDS)('states the verdict a retained admission replay reached over %s', async (kind) => {
    const settlements: ALDeliverySettlement[] = [];
    const stores = createStores(kind);
    const store = stores.admissionStore;
    const competitor = await computeOutboundTestAdmission(store, createOutboundMessage('competing-sender-version'));
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
    expect(pending.status).toBe('pending-admission');
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
        attemptId: firstAttemptId(message.id.msgId),
        outcome: 'failed',
        submissionAttempted: false,
        detail: 'WS connection dropped mid-send',
        willRetry: true
    });
    // The work handler still saw the throw: the row is retained for another attempt, not completed.
    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeDefined();
});

/**
 * An `ack-timeout` row expires on the receipt's own retry budget, never on the message deadline, so
 * reaching that budget says nothing about the message. The owner's clock passes the row's budget
 * while the queue, on its own clock, still serves the row.
 */
it('states no expiry when a row that expires on its own budget reaches it', async () => {
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
            expectedPeerIds: ['peer-1']
        }),
        sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
    });

    await enqueueOutboundOrThrow(runtime, createOutboundMessage('msg-ack-timeout-budget'));
    expect(settlements.map((settlement) => settlement.kind)).toEqual(['attempt-started', 'attempt-settled']);

    // The acknowledgement row falls due on the queue's clock; the owner's clock is past its budget.
    await new Promise((resolve) => setTimeout(resolve, ACK_TIMEOUT_WINDOW_MS + 30));
    ownerNowMs = Date.now() + ACK_TIMEOUT_BUDGET_OVERSHOOT_MS;
    await runOutboundWorkTask(runtime);

    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
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
