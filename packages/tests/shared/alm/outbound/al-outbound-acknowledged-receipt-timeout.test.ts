import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { newALAckControlMessage, newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type {
    ALOutboundAckTrackingPlan,
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsEvent,
    ALOutboundRuntimeStores
} from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundAckTimeoutEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus, type ALMessage } from '@shared/mod.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { acceptWsQueueBoxClientControlMessage } from '@shared/services/ws-queue-box-client/ws-queue-box-client-receipt-tracking.ts';

import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createOutboundMessage
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const NAMESPACE = 'outbound-acknowledged-receipt';
const ACK_TIMEOUT_MS = 2_000;
/** One more than the work page of 16, which reads its rows in key order, not in readiness order. */
const SEND_COUNT = 17;

interface ReceiptedSendFixture {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    /** Each dispatched message, with the index of the durable drain its batch reports when it ends. */
    readonly dispatchedInDrain: Map<string, number>;
    readonly durableDrainCount: () => number;
    readonly settlements: ALDeliverySettlement[];
}

describe('an acknowledged receipt and its ACK-timeout work row', () => {
    it('dispatches every one of 17 acknowledged receipted sends in the batch its own commit runs', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const drainOffsets: number[] = [];

        for (let index = 0; index < SEND_COUNT; index += 1) {
            const msg = createOutboundMessage(`receipted-${index}`);
            const drainedBefore = fixture.durableDrainCount();
            expect((await fixture.runtime.enqueueIfAbsent(msg)).verdict).toMatchObject({
                kind: 'admitted'
            });
            await vi.waitFor(() => expect(fixture.durableDrainCount()).toBeGreaterThan(drainedBefore), {
                timeout: ACK_TIMEOUT_MS + 1_000,
                interval: 5
            });
            await vi.waitFor(() => expect(fixture.dispatchedInDrain.has(msg.id.msgId)).toBe(true), {
                timeout: ACK_TIMEOUT_MS + 1_000,
                interval: 5
            });
            drainOffsets.push(fixture.dispatchedInDrain.get(msg.id.msgId)! - drainedBefore);
            await acknowledgeAndDrain(fixture, msg, 'server');
        }

        // Left pending, the acknowledged sends' timeout rows filled the claim's page: the 16th send's own batch
        // claimed nothing, and a later batch sent it once the first of those rows fell due.
        expect(drainOffsets, JSON.stringify(drainOffsets)).toEqual(Array.from({ length: SEND_COUNT }, () => 0));
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

    it('leaves an ACK-timeout row a batch already leased to that batch, which completes it', async () => {
        const fixture = await createReceiptedSendFixture(['server']);
        const msg = await sendUntilDispatched(fixture, 'leased-timeout');
        const timeoutKey = await readAckTimeoutKey(fixture, msg);
        const timeoutRead = holdFirstRepairRead(fixture);
        await timeoutRead.started;
        const leased = await fixture.stores.workQueue.getItem(timeoutKey);
        expect(leased?.status).toBe(EntityStatus.RESERVED);

        await acknowledge(fixture, msg, 'server');

        expect(await fixture.stores.workQueue.getItem(timeoutKey)).toEqual(leased);
        timeoutRead.release();
        await vi.waitFor(async () => expect((await fixture.stores.workQueue.getItem(timeoutKey))?.status).toBe(EntityStatus.COMPLETED));
    });
});

async function createReceiptedSendFixture(
    expectedPeerIds: readonly string[]
): Promise<ReceiptedSendFixture> {
    const stores = createIndexedDbOutboundTestStores({
        observer: createPassThroughIndexedDbOperationObserver(),
        namespace: NAMESPACE
    });
    const dispatchedInDrain = new Map<string, number>();
    const durableDrains: ALOutboundRuntimeDiagnosticsEvent[] = [];
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
        diagnostics: (event) => {
            if (event.kind === 'effect-drain' && event.lane === 'durable') {
                durableDrains.push(event);
            }
        },
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: 'durable',
            preparedMessages: [{ kind: 'send' }],
            ackTracking,
            retryTracking: { enabled: true, maxAttempts: 3 }
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            // The dispatching batch reports its drain only when it ends, so the next drain is its own.
            dispatchedInDrain.set(lifecycle.canonicalMessage.id.msgId, durableDrains.length);
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    await runtime.ready();
    return {
        runtime,
        stores,
        dispatchedInDrain,
        durableDrainCount: () => durableDrains.length,
        settlements
    };
}

async function sendUntilDispatched(
    fixture: ReceiptedSendFixture,
    resourceId: string
): Promise<ALMessage> {
    const msg = createOutboundMessage(resourceId);
    await fixture.runtime.enqueueIfAbsent(msg);
    await vi.waitFor(() => expect(fixture.dispatchedInDrain.has(msg.id.msgId)).toBe(true));
    return msg;
}

interface HeldRepairRead {
    readonly started: Promise<void>;
    readonly release: () => void;
}

/** Holds the first repair read, the ACK-timeout claim's own, so the row stays leased while the test acts. */
function holdFirstRepairRead(fixture: ReceiptedSendFixture): HeldRepairRead {
    const { admissionStore } = fixture.stores;
    const readRepairMessage = admissionStore.readRepairMessage.bind(admissionStore);
    let markStarted: () => void = () => {};
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    vi.spyOn(admissionStore, 'readRepairMessage').mockImplementationOnce(async (msgId, planner) => {
        markStarted();
        await released;
        return await readRepairMessage(msgId, planner);
    });
    return { started, release };
}

/** The row the send's commit scheduled for its receipt's first timeout, named from the receipt it tracks. */
async function readAckTimeoutKey(fixture: ReceiptedSendFixture, msg: ALMessage) {
    const pending = await fixture.stores.admissionStore.readReceiptState({
        originPeerId: 'self',
        msgId: msg.id.msgId
    });
    expect(pending).toBeDefined();
    return toALOutboundWorkKey(NAMESPACE, toALOutboundAckTimeoutEffectId(pending!));
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

/** Acknowledges and waits for the batch the acknowledgement's commit runs, so the next send finds the owner idle. */
async function acknowledgeAndDrain(
    fixture: ReceiptedSendFixture,
    msg: ALMessage,
    recipientPeerId: string
): Promise<void> {
    const drainedBefore = fixture.durableDrainCount();
    await acknowledge(fixture, msg, recipientPeerId);
    await vi.waitFor(() => expect(fixture.durableDrainCount()).toBeGreaterThan(drainedBefore));
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
