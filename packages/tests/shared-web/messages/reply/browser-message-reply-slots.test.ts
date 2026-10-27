import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { BrowserMessageReplySlots } from '@shared-web/browser/messages/reply/browser-message-reply-slots.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliveryLifecycle,
    type ALDeliveryState
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

const REQUEST_ID = 'request-1';
const UNICAST_REQUEST: BrowserMessageReplySlots.Request = {
    msgId: REQUEST_ID,
    corrId: REQUEST_ID,
    expectedResponderId: 'responder-1'
};
const AUDIENCE_REQUEST: BrowserMessageReplySlots.Request = { ...UNICAST_REQUEST, expectedResponderId: undefined };

describe('BrowserMessageReplySlots', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('awaitReply precedence at call', () => {
        it('returns a recorded reply even when the request has since failed', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const reply = toReply('reply-1', 'responder-1');
            slots.record(reply);

            const outcome = await slots.awaitReply(REQUEST_ID, () => toLifecycle('failed'), {
                timeoutMs: 1_000,
                signal: AbortSignal.abort()
            });

            expect(outcome).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
        });

        it('returns timeout for a timed-out slot before it reads an undelivered lifecycle', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const first = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            await first;

            const outcome = await slots.awaitReply(REQUEST_ID, () => toLifecycle('failed'), { timeoutMs: 1_000 });

            expect(outcome).toEqual({ status: 'timeout', lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
        });

        it.each(['rejected', 'failed', 'expired', 'superseded', 'cancelled', 'unobservable'] as const)(
            'returns undelivered for a request terminal %s before it reads an aborted signal',
            async (state) => {
                const slots = openSlots(UNICAST_REQUEST);

                const outcome = await slots.awaitReply(REQUEST_ID, () => toLifecycle(state), {
                    timeoutMs: 1_000,
                    signal: AbortSignal.abort()
                });

                expect(outcome).toEqual({ status: 'undelivered', lifecycle: toLifecycle(state) });
                expect(vi.getTimerCount()).toBe(0);
            }
        );

        it.each(
            [
                ['acknowledged', 'receipted'],
                ['transport-accepted', 'receipted'],
                ['transport-accepted', 'best-effort']
            ] as const
        )(
            'arms a wait for a request %s (%s), since its reply can still come',
            async (state, receipt) => {
                const slots = openSlots(UNICAST_REQUEST);

                const pending = slots.awaitReply(REQUEST_ID, () => toLifecycle(state, receipt), { timeoutMs: 1_000 });

                expect(slots.hasOpenWait(REQUEST_ID)).toBe(true);
                expect(vi.getTimerCount()).toBe(1);
                await vi.advanceTimersByTimeAsync(1_000);
                expect((await pending).status).toBe('timeout');
            }
        );

        it('returns aborted for an already aborted signal without arming a timer', async () => {
            const slots = openSlots(UNICAST_REQUEST);

            const outcome = await slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), {
                timeoutMs: 1_000,
                signal: AbortSignal.abort()
            });

            expect(outcome).toEqual({ status: 'aborted', lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slots.hasOpenWait(REQUEST_ID)).toBe(false);
        });
    });

    describe('one reply per slot', () => {
        it('resolves every open wait with the first reply and refuses a second one as late', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const first = slots.awaitReply(REQUEST_ID, () => toLifecycle('acknowledged'), { timeoutMs: 1_000 });
            const second = slots.awaitReply(REQUEST_ID, () => toLifecycle('acknowledged'), { timeoutMs: 5_000 });
            const reply = toReply('reply-1', 'responder-1');

            expect(slots.record(reply)).toEqual({ kind: 'matched' });
            expect(slots.record(toReply('reply-2', 'responder-1'))).toEqual({ kind: 'late', cause: 'replied' });

            expect(await first).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('acknowledged') });
            expect(await second).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('acknowledged') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slots.hasOpenWait(REQUEST_ID)).toBe(false);
        });

        it('keeps a reply that arrives before anyone awaits and returns it at once', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const reply = toReply('reply-1', 'responder-1');

            expect(slots.record(reply)).toEqual({ kind: 'matched' });
            const outcome = await slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 1_000 });

            expect(outcome).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('timeout', () => {
        it('closes the slot at the first timeout and resolves every open wait timeout', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const short = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 100 });
            const long = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 5_000 });

            await vi.advanceTimersByTimeAsync(100);

            expect(await short).toEqual({ status: 'timeout', lifecycle: toLifecycle('queued') });
            expect(await long).toEqual({ status: 'timeout', lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slots.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'late', cause: 'timed-out' });
        });

        it('reads the request lifecycle without changing it when the wait times out', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const lifecycle = toLifecycle('queued');
            const readLifecycle = vi.fn(() => lifecycle);

            const pending = slots.awaitReply(REQUEST_ID, readLifecycle, { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);

            const outcome = await pending;
            expect(outcome.status).toBe('timeout');
            expect(outcome.lifecycle).toBe(lifecycle);
            expect(lifecycle).toEqual(toLifecycle('queued'));
        });
    });

    describe('waits that end alone', () => {
        it('ends only the aborted wait and leaves the slot open for a reply', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const controller = new AbortController();
            const aborted = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), {
                timeoutMs: 1_000,
                signal: controller.signal
            });
            const kept = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 1_000 });

            controller.abort();

            expect(await aborted).toEqual({ status: 'aborted', lifecycle: toLifecycle('queued') });
            expect(slots.hasOpenWait(REQUEST_ID)).toBe(true);
            const reply = toReply('reply-1', 'responder-1');
            expect(slots.record(reply)).toEqual({ kind: 'matched' });
            expect((await kept).status).toBe('replied');
        });

        it('ends open waits undelivered when the request fails and leaves the slot open for a late answer', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const pending = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 1_000 });

            slots.settleLifecycle(REQUEST_ID, toLifecycle('failed'));

            expect(await pending).toEqual({ status: 'undelivered', lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slots.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'matched' });
        });

        it.each(
            [
                ['queued', 'receipted'],
                ['transport-accepted', 'receipted'],
                ['transport-accepted', 'best-effort'],
                ['acknowledged', 'receipted']
            ] as const
        )(
            'keeps open waits when the request lifecycle reaches %s (%s)',
            (state, receipt) => {
                const slots = openSlots(UNICAST_REQUEST);
                void slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 1_000 });

                slots.settleLifecycle(REQUEST_ID, toLifecycle(state, receipt));

                expect(slots.hasOpenWait(REQUEST_ID)).toBe(true);
            }
        );
    });

    describe('a lifecycle settled while a reply or a timeout is being delivered', () => {
        it('resolves every wait replied even when reading a wait\'s lifecycle ends the request', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const lapsing = createLapsingLifecycle(slots);
            const first = slots.awaitReply(REQUEST_ID, lapsing.read, { timeoutMs: 1_000 });
            const second = slots.awaitReply(REQUEST_ID, lapsing.read, { timeoutMs: 1_000 });
            const reply = toReply('reply-1', 'responder-1');
            lapsing.lapse();

            slots.record(reply);

            expect(await first).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('expired') });
            expect(await second).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('expired') });
        });

        it('resolves every wait timeout even when reading a wait\'s lifecycle ends the request', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const lapsing = createLapsingLifecycle(slots);
            const first = slots.awaitReply(REQUEST_ID, lapsing.read, { timeoutMs: 100 });
            const second = slots.awaitReply(REQUEST_ID, lapsing.read, { timeoutMs: 1_000 });
            lapsing.lapse();

            await vi.advanceTimersByTimeAsync(100);

            expect(await first).toEqual({ status: 'timeout', lifecycle: toLifecycle('expired') });
            expect(await second).toEqual({ status: 'timeout', lifecycle: toLifecycle('expired') });
        });
    });

    describe('release', () => {
        it('resolves open waits undelivered with the released lifecycle and answers later replies unobserved', async () => {
            const slots = openSlots(UNICAST_REQUEST);
            const pending = slots.awaitReply(REQUEST_ID, () => toLifecycle('queued'), { timeoutMs: 1_000 });

            slots.release(REQUEST_ID, toLifecycle('unobservable'));

            expect(await pending).toEqual({ status: 'undelivered', lifecycle: toLifecycle('unobservable') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slots.hasOpenWait(REQUEST_ID)).toBe(false);
            expect(slots.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'late', cause: 'unobserved' });
        });
    });

    describe('record', () => {
        it('answers a reply to a request it never opened unobserved', () => {
            const slots = openSlots(UNICAST_REQUEST);

            expect(slots.record(toReply('reply-1', 'responder-1', 'request-unknown'))).toEqual({
                kind: 'late',
                cause: 'unobserved'
            });
        });

        it('refuses a reply to a unicast from another sender and keeps the slot open', () => {
            const slots = openSlots(UNICAST_REQUEST);

            expect(slots.record(toReply('reply-1', 'responder-2'))).toEqual({
                kind: 'wrong-responder',
                expectedSenderId: 'responder-1'
            });
            expect(slots.record(toReply('reply-2', 'responder-1'))).toEqual({ kind: 'matched' });
        });

        it('accepts a reply to an audience request from any sender', () => {
            const slots = openSlots(AUDIENCE_REQUEST);

            expect(slots.record(toReply('reply-1', 'anyone'))).toEqual({ kind: 'matched' });
        });
    });
});

/** Models the registry's lazy deadline: once lapsed, a read publishes `expired` back into the slots. */
function createLapsingLifecycle(slots: BrowserMessageReplySlots): Readonly<{ read(): ALDeliveryLifecycle; lapse(): void; }> {
    let lapsed = false;
    return {
        read: () => {
            if (!lapsed) {
                return toLifecycle('queued');
            }
            slots.settleLifecycle(REQUEST_ID, toLifecycle('expired'));
            return toLifecycle('expired');
        },
        lapse: () => {
            lapsed = true;
        }
    };
}

function openSlots(request: BrowserMessageReplySlots.Request): BrowserMessageReplySlots {
    const slots = new BrowserMessageReplySlots();
    slots.open(request);
    return slots;
}

/** `best-effort` asks for no receipt, so its `transport-accepted` is terminal. */
function toLifecycle(state: ALDeliveryState, receipt: 'receipted' | 'best-effort' = 'receipted'): ALDeliveryLifecycle {
    const initial = createInitialALDeliveryLifecycle({
        msgId: REQUEST_ID,
        typeId: 'app.ask.v1',
        ackMode: receipt === 'receipted' ? 'receiver' : 'none',
        receiptAlgo: receipt === 'receipted' ? 'receiver' : 'none',
        expiresAtMs: undefined,
        submittedAtMs: 0
    });
    return { ...initial, state };
}

function toReply(msgId: string, senderId: string, replyToMsgId = REQUEST_ID): RallarMessage<RallarMessagePayload> {
    return {
        transport: 'ws',
        typeId: 'app.ask.v1',
        topicId: 'app.ask',
        contextId: 'room-1',
        resourceId: 'resource-1',
        senderId,
        payload: { answer: 42 },
        raw: {
            id: { v: 3, msgId, ts: 0, senderId },
            route: { topicId: 'app.ask', contextId: 'room-1', resourceId: 'resource-1' },
            payload: { typeId: 'app.ask.v1', resource: '{"answer":42}' },
            actions: { corrId: REQUEST_ID, replyToMsgId }
        },
        receivedAtEpochMs: 0,
        reply: vi.fn()
    };
}
