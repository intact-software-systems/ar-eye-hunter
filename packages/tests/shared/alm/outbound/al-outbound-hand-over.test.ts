import { DEFAULT_AL_REPOSITORY_TTL_MS } from '@shared/alm/ALStoreRetention.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkKey } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { ALOutboundSendControls } from '@shared/alm/outbound/lane/al-outbound-send-controls.ts';
import { writeALOutboundMessageEnd } from '@shared/alm/outbound/message-end/write-al-outbound-message-end.ts';
import { toALOutboundEndMessageEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
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
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

interface HandOverFixture {
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly settlements: ALDeliverySettlement[];
    readonly sent: string[];
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
}

/** `persist` routes the message to the durable pair or to the volatile memory pair, which ends the message in its own store. */
function createHandOverFixture(persist: boolean, receiptTimeoutMs = 60_000): HandOverFixture {
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
    beforeEach(() =>
        onTestFinished(() => {
            vi.useRealTimers();
            vi.restoreAllMocks();
        })
    );

    it.each([true, false])(
        'marks the stored message ended, deletes its receipt row, ends every later effect of it, and states no cancellation (persist: %s)',
        async (persist) => {
            const fixture = createHandOverFixture(persist);
            const claims = holdOutboundClaims(fixture.stores);
            const message = createOutboundMessage('hand-over');
            const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
            expect((await fixture.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('admitted');
            expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeDefined();

            await fixture.runtime.handOver(message.id.msgId);
            expect(await fixture.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' });
            expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeUndefined();
            await claims.release(fixture.runtime);
            await runOutboundWorkTask(fixture.runtime);

            expect(fixture.sent).toEqual([]);
            const kinds = fixture.settlements.map((settlement) => settlement.kind);
            expect(kinds).not.toContain('cancelled');
            expect(kinds).not.toContain('attempt-started');
        }
    );

    it('retains its end as work when the commit conflicts, and the run of that row stores it and deletes the receipt row (C6)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const fixture = createHandOverFixture(true, 1_000);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over-conflict');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        await fixture.runtime.enqueueIfAbsent(message);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        await fixture.runtime.handOver(message.id.msgId);
        expect((await fixture.stores.admissionStore.readSendGuards(message)).kind).toBe('current');
        const endKey = toALOutboundWorkKey(
            fixture.stores.admissionStore.namespace,
            toALOutboundEndMessageEffectId(message.id.msgId)
        );
        expect((await fixture.stores.workQueue.getItem(endKey))?.status).toBe(EntityStatus.NEW);
        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeDefined();
        await claims.release(fixture.runtime);
        await runOutboundWorkTask(fixture.runtime);
        // Past the receipt's first window and inside the message deadline: a live receipt would charge an attempt.
        vi.setSystemTime(Date.now() + 2_000);
        await runOutboundWorkTask(fixture.runtime);

        expect(await fixture.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' });
        expect((await fixture.stores.workQueue.getItem(endKey))?.status).toBe(EntityStatus.COMPLETED);
        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeUndefined();
        expect(await peekOutboundWorkReadyAt(fixture.stores.workQueue, fixture.stores.admissionStore.namespace))
            .toBeUndefined();
        expect(fixture.sent).toEqual([]);
        expect(fixture.settlements).toEqual([]);
    });

    it('deletes the receipt row of a message an earlier end already marked, as the fallback after receipt-exhausted does', async () => {
        const fixture = createHandOverFixture(true);
        const message = createOutboundMessage('hand-over-after-end');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        await fixture.runtime.enqueueIfAbsent(message);
        // Every terminal end commits this bundle and keeps the receipt row as its final snapshot.
        expect(await writeALOutboundMessageEnd(fixture.stores.admissionStore, message.id.msgId, 'cancelled'))
            .toEqual({ kind: 'ended' });
        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeDefined();

        await fixture.runtime.handOver(message.id.msgId);

        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toBeUndefined();
        expect(await fixture.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' });
        expect(fixture.settlements.map((settlement) => settlement.kind)).not.toContain('cancelled');
    });

    it.each([true, false])('marks the stored message ended on a cancel and keeps its receipt row as the final snapshot (persist: %s)', async (persist) => {
        const fixture = createHandOverFixture(persist);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('cancel-keeps-receipt');
        const receipt = { originPeerId: message.id.senderId, msgId: message.id.msgId };
        await fixture.runtime.enqueueIfAbsent(message);
        const admitted = await fixture.stores.admissionStore.readPendingAck(receipt);
        expect(admitted).toBeDefined();

        fixture.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await fixture.stores.admissionStore.readSendGuards(message)).toEqual({ kind: 'ended' }));
        await claims.release(fixture.runtime);

        expect(await fixture.stores.admissionStore.readPendingAck(receipt)).toEqual(admitted);
    });

    it('is idempotent, and a later cancel still states its own settlement', async () => {
        const fixture = createHandOverFixture(true);
        const claims = holdOutboundClaims(fixture.stores);
        const message = createOutboundMessage('hand-over-twice');
        await fixture.runtime.enqueueIfAbsent(message);

        await fixture.runtime.handOver(message.id.msgId);
        await fixture.runtime.handOver(message.id.msgId);
        await claims.release(fixture.runtime);

        expect(fixture.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
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
