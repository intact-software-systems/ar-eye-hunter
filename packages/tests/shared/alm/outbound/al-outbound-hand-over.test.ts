import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { ALOutboundSendControls } from '@shared/alm/outbound/lane/al-outbound-send-controls.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    createVolatileOutboundTestStores,
    holdOutboundClaims,
    peekOutboundWorkReadyAt,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';

/** `persist` routes the message to the durable pair or to the volatile memory pair, whose `endReceipt` is its own. */
function createHandOverFixture(persist: boolean, receiptTimeoutMs = 60_000) {
    const durableStores = createDefaultOutboundTestStores();
    const volatileStores = createVolatileOutboundTestStores();
    const settlements: ALDeliverySettlement[] = [];
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores: durableStores,
        volatileStores,
        // A supplied engine is never started, so only this test's batches ask the held queue for work.
        queueEngine: new InboxOutboxEngine(),
        carrier: 'rtc',
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            lane: persist ? 'durable' : 'volatile',
            preparedMessages: [{ message: msg.id.msgId }],
            ackTracking: { ...trackOutboundTestAcks(['peer-1']), timeoutMs: receiptTimeoutMs }
        }),
        sendPreparedMessage: async (prepared) => {
            sent.push(JSON.stringify(prepared));
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    return { stores: persist ? durableStores : volatileStores, settlements, sent, runtime };
}

describe('the settlement-free hand-over (D56, Q3)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([true, false])('ends the receipt row and every later effect of the message, and states no cancellation (persist: %s)', async (persist) => {
        const fixture = createHandOverFixture(persist);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        expect((await fixture.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeDefined();

        await fixture.runtime.handOver(message.id.msgId);
        await claims.release();
        await runOutboundWorkTask(fixture.runtime);

        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeUndefined();
        expect(fixture.sent).toEqual([]);
        const kinds = fixture.settlements.map((settlement) => settlement.kind);
        expect(kinds).not.toContain('cancelled');
        expect(kinds).not.toContain('attempt-started');
    });

    it('leaves an inert receipt row when its delete conflicts, and its ack-timeout completes silently (C6)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fixture = createHandOverFixture(true, 1_000);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over-conflict');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        await fixture.runtime.enqueueIfAbsent(message);
        const admitted = await fixture.stores.admissionStore.readPendingAck(receipt);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        await fixture.runtime.handOver(message.id.msgId);
        await claims.release();
        await runOutboundWorkTask(fixture.runtime);
        // Past the receipt's first window and inside the message deadline: a live receipt would charge an attempt.
        vi.setSystemTime(Date.now() + 2_000);
        await runOutboundWorkTask(fixture.runtime);

        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toEqual(admitted);
        expect(await peekOutboundWorkReadyAt(fixture.stores.workQueue, fixture.stores.admissionStore.namespace))
            .toBeUndefined();
        expect(fixture.sent).toEqual([]);
        expect(fixture.settlements).toEqual([]);
    });

    it('is idempotent, and a later cancel still states its own settlement', async () => {
        const fixture = createHandOverFixture(true);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over-twice');
        await fixture.runtime.enqueueIfAbsent(message);

        await fixture.runtime.handOver(message.id.msgId);
        await fixture.runtime.handOver(message.id.msgId);
        await claims.release();

        expect(fixture.runtime.cancel(message.id.msgId)).toBe('cancelled');
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'cancelled'))
            .toHaveLength(1);
    });
});

describe('ALOutboundSendControls.handOver', () => {
    it('aborts the live attempt and ends the message without cancelling it', () => {
        const controls = new ALOutboundSendControls({ nowMs: Date.now });
        const signal = controls.acquire('msg-1');

        expect(controls.handOver('msg-1')).toBe('handed-over');
        expect(signal.aborted).toBe(true);
        expect(controls.isEnded('msg-1')).toBe(true);
        expect(controls.handOver('msg-1')).toBe('already-ended');
        expect(controls.cancel('msg-1')).toBe('cancelled');
    });

    it('leaves a cancelled message as it is', () => {
        const controls = new ALOutboundSendControls({ nowMs: Date.now });
        controls.cancel('msg-1');

        expect(controls.handOver('msg-1')).toBe('already-ended');
    });
});

describe('how long the send controls remember an ended message', () => {
    it('remembers a handed-over message for the durable row retention and forgets it after', () => {
        let nowMs = 1_000;
        const controls = new ALOutboundSendControls({ nowMs: () => nowMs });
        controls.handOver('msg-1');

        nowMs += DEFAULT_AL_REPOSITORY_TTL_MS;
        expect(controls.isEnded('msg-1')).toBe(true);
        expect(controls.handOver('msg-1')).toBe('already-ended');

        nowMs += 1;
        expect(controls.isEnded('msg-1')).toBe(false);
        expect(controls.handOver('msg-1')).toBe('handed-over');
    });

    it('remembers a cancelled message for the durable row retention and forgets it after', () => {
        let nowMs = 1_000;
        const controls = new ALOutboundSendControls({ nowMs: () => nowMs });
        controls.cancel('msg-1');

        nowMs += DEFAULT_AL_REPOSITORY_TTL_MS;
        expect(controls.isEnded('msg-1')).toBe(true);
        expect(controls.cancel('msg-1')).toBe('already-cancelled');

        nowMs += 1;
        expect(controls.isEnded('msg-1')).toBe(false);
        expect(controls.cancel('msg-1')).toBe('cancelled');
    });
});
