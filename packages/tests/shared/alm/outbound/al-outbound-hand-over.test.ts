import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { ALOutboundSendControls } from '@shared/alm/outbound/lane/al-outbound-send-controls.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    holdOutboundClaims,
    runOutboundWorkTask,
    trackOutboundTestAcks
} from '../outbound-runtime-test-fixture.ts';

function createHandOverFixture() {
    const stores = createDefaultOutboundTestStores();
    const settlements: ALDeliverySettlement[] = [];
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        // A supplied engine is never started, so only this test's batches ask the held queue for work.
        queueEngine: new InboxOutboxEngine(),
        carrier: 'rtc',
        settlements: (settlement) => settlements.push(settlement),
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [{ message: msg.id.msgId }],
            ackTracking: trackOutboundTestAcks(['peer-1'])
        }),
        sendPreparedMessage: async (prepared) => {
            sent.push(JSON.stringify(prepared));
            return { status: 'sent' as const, submissionAttempted: true };
        }
    });
    return { stores, settlements, sent, runtime };
}

describe('the settlement-free hand-over (D56, Q3)', () => {
    it('ends the receipt row and every later effect of the message, and states no cancellation', async () => {
        const fixture = createHandOverFixture();
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

    it('is idempotent, and a later cancel still states its own settlement', async () => {
        const fixture = createHandOverFixture();
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
        const controls = new ALOutboundSendControls();
        const signal = controls.acquire('msg-1');

        expect(controls.handOver('msg-1')).toBe('handed-over');
        expect(signal.aborted).toBe(true);
        expect(controls.isEnded('msg-1')).toBe(true);
        expect(controls.handOver('msg-1')).toBe('already-ended');
        expect(controls.cancel('msg-1')).toBe('cancelled');
    });

    it('leaves a cancelled message as it is', () => {
        const controls = new ALOutboundSendControls();
        controls.cancel('msg-1');

        expect(controls.handOver('msg-1')).toBe('already-ended');
    });
});
