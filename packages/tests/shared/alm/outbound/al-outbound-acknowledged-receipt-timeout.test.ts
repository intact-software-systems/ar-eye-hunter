import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus, type ALMessage } from '@shared/mod.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';
import { recordIndexedDbTransactionLedger } from '../record-indexed-db-transaction-ledger.ts';

const NAMESPACE = 'outbound-acknowledged-receipt';
const ACK_TIMEOUT_MS = 2_000;
/** One more than the work page of 16, which reads its rows in key order, not in readiness order. */
const SEND_COUNT = 17;

interface ReceiptedSendFixture {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly dispatchedAtMs: Map<string, number>;
    readonly settlements: ALDeliverySettlement[];
}

describe('an acknowledged receipt and its ACK-timeout work row', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('dispatches every one of 17 acknowledged receipted sends without waiting for an ACK timeout', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const sendToDispatchMs: number[] = [];

        for (let index = 0; index < SEND_COUNT; index += 1) {
            const msg = createOutboundMessage(`receipted-${index}`);
            const startedAtMs = performance.now();
            expect((await fixture.runtime.enqueueIfAbsent(msg)).verdict).toMatchObject({
                kind: 'admitted'
            });
            await vi.waitFor(() => expect(fixture.dispatchedAtMs.has(msg.id.msgId)).toBe(true), {
                timeout: ACK_TIMEOUT_MS + 1_000,
                interval: 5
            });
            sendToDispatchMs.push(fixture.dispatchedAtMs.get(msg.id.msgId)! - startedAtMs);
            await acknowledge(fixture, msg, 'server');
        }

        // Left pending, the acknowledged sends' timeout rows filled the claim's page and the 16th send waited for the
        // first of them to fall due.
        expect(
            sendToDispatchMs.filter((ms) => ms >= ACK_TIMEOUT_MS / 2),
            JSON.stringify(sendToDispatchMs)
        )
            .toEqual([]);
    });

    it('completes the ACK-timeout row in the commit that completes the receipt', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const msg = await sendUntilDispatched(fixture, 'complete-receipt');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);
        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(EntityStatus.NEW);

        await acknowledge(fixture, msg, 'server');

        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(
            EntityStatus.COMPLETED
        );
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement'))
            .toEqual([expect.objectContaining({ msgId: msg.id.msgId, complete: true })]);
    });

    it('keeps the ACK-timeout row while the receipt still waits for another recipient', async () => {
        const fixture = await createReceiptedSendFixture(['server', 'peer-2']);
        const msg = await sendUntilDispatched(fixture, 'partial-receipt');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);

        await acknowledge(fixture, msg, 'server');

        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(EntityStatus.NEW);
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement'))
            .toEqual([expect.objectContaining({ msgId: msg.id.msgId, complete: false })]);
    });

    it('completes the ACK-timeout row in the commit of a NACK that refuses the message for good', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const msg = await sendUntilDispatched(fixture, 'refused-receipt');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);
        const settledBefore = fixture.settlements.length;

        await refuseForGood(fixture, msg, 'server');

        expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(
            EntityStatus.COMPLETED
        );
        // The same two facts the refusal stated while its timeout row was left to run at the deadline.
        expect(fixture.settlements.slice(settledBefore)).toEqual([
            expect.objectContaining({ kind: 'acknowledgement', msgId: msg.id.msgId, complete: false }),
            expect.objectContaining({
                kind: 'receipt-exhausted',
                msgId: msg.id.msgId,
                cause: 'hop-refused',
                hopPeerId: 'server',
                nackReason: 'expired'
            })
        ]);
    });
});

async function createReceiptedSendFixture(
    expectedPeerIds: readonly string[]
): Promise<ReceiptedSendFixture> {
    const stores = createIndexedDbOutboundTestStores({
        observer: recordIndexedDbTransactionLedger().observer,
        namespace: NAMESPACE
    });
    const dispatchedAtMs = new Map<string, number>();
    const settlements: ALDeliverySettlement[] = [];
    const ackTracking: ALOutboundAckTrackingPlan = {
        enabled: true,
        timeoutMs: ACK_TIMEOUT_MS,
        maxAttempts: 3,
        expectedPeerIds,
        nextHopPeerIds: expectedPeerIds,
        mode: 'receiver'
    };
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ kind: 'send' }],
            ackTracking,
            retryTracking: { enabled: true, maxAttempts: 3 }
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            dispatchedAtMs.set(lifecycle.canonicalMessage.id.msgId, performance.now());
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await runtime.ready();
    return { runtime, stores, dispatchedAtMs, settlements };
}

async function sendUntilDispatched(
    fixture: ReceiptedSendFixture,
    resourceId: string
): Promise<ALMessage> {
    const msg = createOutboundMessage(resourceId);
    await fixture.runtime.enqueueIfAbsent(msg);
    await vi.waitFor(() => expect(fixture.dispatchedAtMs.has(msg.id.msgId)).toBe(true));
    return msg;
}

/** The row the send's commit scheduled for its receipt's first timeout, named from the receipt it tracks. */
async function readAckTimeoutKey(fixture: ReceiptedSendFixture, msg: ALMessage) {
    const pending = await fixture.stores.admissionStore.readReceiptState({
        originPeerId: 'self',
        msgId: msg.id.msgId
    });
    expect(pending).toBeDefined();
    return toALOutboundWorkKey(
        NAMESPACE,
        toALOutboundEffectId([
            'ack-timeout',
            msg.id.msgId,
            pending!.attempts + 1,
            pending!.deadlineAtMs
        ])
    );
}

/** The terminal refusal the WS server sends as the relay: the message expired before it could deliver it. */
async function refuseForGood(
    fixture: ReceiptedSendFixture,
    msg: ALMessage,
    relayPeerId: string
): Promise<void> {
    const nack = newALNackControlMessage(
        { v: 2, msgId: `${relayPeerId}-nack:${msg.id.msgId}`, senderId: relayPeerId, ts: Date.now() },
        {
            msgId: msg.id.msgId,
            fromPeerId: relayPeerId,
            toPeerId: 'self',
            reason: 'expired',
            observedAtEpochMs: Date.now()
        }
    );
    expect(await acceptWsQueueBoxClientControlMessage(fixture.runtime, nack)).toEqual({
        kind: 'committed'
    });
}

/** The recipient's own ACK, as the WS server answers a command addressed to it, through the client's control path. */
async function acknowledge(
    fixture: ReceiptedSendFixture,
    msg: ALMessage,
    recipientPeerId: string
): Promise<void> {
    const observedAtEpochMs = Date.now();
    const ack = newALAckControlMessage(
        {
            v: 2,
            msgId: `${recipientPeerId}-ack:${msg.id.msgId}`,
            senderId: recipientPeerId,
            ts: observedAtEpochMs
        },
        {
            ackedMsgId: msg.id.msgId,
            fromPeerId: recipientPeerId,
            toPeerId: 'self',
            originPeerId: 'self',
            logicalRecipientPeerId: recipientPeerId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs
        }
    );
    expect(await acceptWsQueueBoxClientControlMessage(fixture.runtime, ack)).toEqual({
        kind: 'committed'
    });
}
