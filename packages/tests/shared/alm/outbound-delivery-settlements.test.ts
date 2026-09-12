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
    ALOutboundDispatchPlan,
    ALOutboundRuntimeStores,
    ALOutboundSettledSendResult
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

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
    expectedPeerIds?: readonly string[]
): (msg: ALMessage) => ALOutboundDispatchPlan<OutboundTestPayload> {
    return (msg) => ({
        msg,
        dropReasonCode: undefined,
        persist: true,
        preparedMessages: [PREPARED],
        ackTracking: expectedPeerIds === undefined ? undefined : {
            enabled: true,
            timeoutMs: 60_000,
            maxAttempts: 3,
            expectedPeerIds
        }
    });
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
        planOutgoingMessage: planSend(['peer-1', 'peer-2']),
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
    const reported: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...entry) => {
        reported.push(entry[0]);
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
