import type { RallarMessage, RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { BrowserMessageReplySlot } from '@shared-web/browser/messages/reply/browser-message-reply-slot.ts';
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

describe('BrowserMessageReplySlot', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('awaitReply precedence at call', () => {
        it('returns a recorded reply even when the request has since failed', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const reply = toReply('reply-1', 'responder-1');
            slot.record(reply);

            const outcome = await slot.awaitReply(() => toLifecycle('failed'), {
                timeoutMs: 1_000,
                signal: AbortSignal.abort()
            });

            expect(outcome).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
        });

        it('returns timeout for a timed-out slot before it reads an undelivered lifecycle', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const first = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);
            await first;

            const outcome = await slot.awaitReply(() => toLifecycle('failed'), { timeoutMs: 1_000 });

            expect(outcome).toEqual({ status: 'timeout', lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
        });

        it.each(['rejected', 'failed', 'expired', 'superseded', 'cancelled', 'unobservable'] as const)(
            'returns undelivered for a request terminal %s before it reads an aborted signal',
            async (state) => {
                const slot = new BrowserMessageReplySlot('responder-1');

                const outcome = await slot.awaitReply(() => toLifecycle(state), {
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
                const slot = new BrowserMessageReplySlot('responder-1');

                const pending = slot.awaitReply(() => toLifecycle(state, receipt), { timeoutMs: 1_000 });

                expect(slot.getWaitCount()).toBeGreaterThan(0);
                expect(vi.getTimerCount()).toBe(1);
                await vi.advanceTimersByTimeAsync(1_000);
                expect((await pending).status).toBe('timeout');
            }
        );

        it('returns aborted for an already aborted signal without arming a timer', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');

            const outcome = await slot.awaitReply(() => toLifecycle('queued'), {
                timeoutMs: 1_000,
                signal: AbortSignal.abort()
            });

            expect(outcome).toEqual({ status: 'aborted', lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.getWaitCount()).toBe(0);
        });
    });

    describe('one reply per slot', () => {
        it('resolves every open wait with the first reply and refuses a second one as late', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const first = slot.awaitReply(() => toLifecycle('acknowledged'), { timeoutMs: 1_000 });
            const second = slot.awaitReply(() => toLifecycle('acknowledged'), { timeoutMs: 5_000 });
            const reply = toReply('reply-1', 'responder-1');

            expect(slot.record(reply)).toEqual({ kind: 'matched' });
            expect(slot.record(toReply('reply-2', 'responder-1'))).toEqual({ kind: 'late', cause: 'replied' });

            expect(await first).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('acknowledged') });
            expect(await second).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('acknowledged') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.getWaitCount()).toBe(0);
        });

        it('keeps a reply that arrives before anyone awaits and returns it at once', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const reply = toReply('reply-1', 'responder-1');

            expect(slot.record(reply)).toEqual({ kind: 'matched' });
            const outcome = await slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 1_000 });

            expect(outcome).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('timeout', () => {
        it('closes the slot at the first timeout and resolves every open wait timeout', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const short = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 100 });
            const long = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 5_000 });

            await vi.advanceTimersByTimeAsync(100);

            expect(await short).toEqual({ status: 'timeout', lifecycle: toLifecycle('queued') });
            expect(await long).toEqual({ status: 'timeout', lifecycle: toLifecycle('queued') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'late', cause: 'timed-out' });
        });

        it('reads the request lifecycle without changing it when the wait times out', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const lifecycle = toLifecycle('queued');
            const readLifecycle = vi.fn(() => lifecycle);

            const pending = slot.awaitReply(readLifecycle, { timeoutMs: 100 });
            await vi.advanceTimersByTimeAsync(100);

            const outcome = await pending;
            expect(outcome.status).toBe('timeout');
            expect(outcome.lifecycle).toBe(lifecycle);
            expect(lifecycle).toEqual(toLifecycle('queued'));
        });
    });

    describe('waits that end alone', () => {
        it('ends only the aborted wait and leaves the slot open for a reply', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const controller = new AbortController();
            const aborted = slot.awaitReply(() => toLifecycle('queued'), {
                timeoutMs: 1_000,
                signal: controller.signal
            });
            const kept = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 1_000 });

            controller.abort();

            expect(await aborted).toEqual({ status: 'aborted', lifecycle: toLifecycle('queued') });
            expect(slot.getWaitCount()).toBeGreaterThan(0);
            const reply = toReply('reply-1', 'responder-1');
            expect(slot.record(reply)).toEqual({ kind: 'matched' });
            expect((await kept).status).toBe('replied');
        });

        it('ends open waits undelivered when the request fails and leaves the slot open for a late answer', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const pending = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 1_000 });

            slot.settleLifecycle(toLifecycle('failed'));

            expect(await pending).toEqual({ status: 'undelivered', lifecycle: toLifecycle('failed') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'matched' });
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
                const slot = new BrowserMessageReplySlot('responder-1');
                void slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 1_000 });

                slot.settleLifecycle(toLifecycle(state, receipt));

                expect(slot.getWaitCount()).toBeGreaterThan(0);
            }
        );
    });

    describe('a lifecycle settled while a reply or a timeout is being delivered', () => {
        it('resolves every wait replied even when reading a wait\'s lifecycle ends the request', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const lapsing = createLapsingLifecycle(slot);
            const first = slot.awaitReply(lapsing.read, { timeoutMs: 1_000 });
            const second = slot.awaitReply(lapsing.read, { timeoutMs: 1_000 });
            const reply = toReply('reply-1', 'responder-1');
            lapsing.lapse();

            slot.record(reply);

            expect(await first).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('expired') });
            expect(await second).toEqual({ status: 'replied', reply, lifecycle: toLifecycle('expired') });
        });

        it('resolves every wait undelivered when the timeout\'s lifecycle read finds the deadline lapsed', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const lapsing = createLapsingLifecycle(slot);
            const first = slot.awaitReply(lapsing.read, { timeoutMs: 100 });
            const second = slot.awaitReply(lapsing.read, { timeoutMs: 1_000 });
            lapsing.lapse();

            await vi.advanceTimersByTimeAsync(100);

            expect(await first).toEqual({ status: 'undelivered', lifecycle: toLifecycle('expired') });
            expect(await second).toEqual({ status: 'undelivered', lifecycle: toLifecycle('expired') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.record(toReply('reply-1', 'responder-1'))).toEqual({ kind: 'matched' });
        });
    });

    describe('release', () => {
        it('resolves open waits undelivered with the released lifecycle, and every later wait at once', async () => {
            const slot = new BrowserMessageReplySlot('responder-1');
            const pending = slot.awaitReply(() => toLifecycle('queued'), { timeoutMs: 1_000 });

            slot.release(toLifecycle('unobservable'));

            expect(await pending).toEqual({ status: 'undelivered', lifecycle: toLifecycle('unobservable') });
            expect(vi.getTimerCount()).toBe(0);
            expect(slot.getWaitCount()).toBe(0);
            expect(await slot.awaitReply(() => toLifecycle('unobservable'), { timeoutMs: 1_000 })).toEqual({
                status: 'undelivered',
                lifecycle: toLifecycle('unobservable')
            });
            expect(vi.getTimerCount()).toBe(0);
        });
    });

    describe('record', () => {
        it('refuses a reply to a unicast from another sender and keeps the slot open', () => {
            const slot = new BrowserMessageReplySlot('responder-1');

            expect(slot.record(toReply('reply-1', 'responder-2'))).toEqual({
                kind: 'wrong-responder',
                expectedSenderId: 'responder-1'
            });
            expect(slot.record(toReply('reply-2', 'responder-1'))).toEqual({ kind: 'matched' });
        });

        it('accepts a reply to an audience request from any sender', () => {
            const slot = new BrowserMessageReplySlot(undefined);

            expect(slot.record(toReply('reply-1', 'anyone'))).toEqual({ kind: 'matched' });
        });
    });
});

/** Models the registry's lazy deadline: once lapsed, a read publishes `expired` back into the slot. */
function createLapsingLifecycle(slot: BrowserMessageReplySlot): Readonly<{ read(): ALDeliveryLifecycle; lapse(): void; }> {
    let lapsed = false;
    return {
        read: () => {
            if (!lapsed) {
                return toLifecycle('queued');
            }
            slot.settleLifecycle(toLifecycle('expired'));
            return toLifecycle('expired');
        },
        lapse: () => {
            lapsed = true;
        }
    };
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

function toReply(msgId: string, senderId: string): RallarMessage<RallarMessagePayload> {
    return {
        transport: 'ws',
        typeId: 'app.ask.v1',
        topicId: 'app.ask',
        contextId: 'room-1',
        resourceId: 'resource-1',
        senderId,
        traceId: 'trace-browser-message-reply-slot',
        payload: { answer: 42 },
        raw: {
            id: { v: 4, msgId, ts: 0, senderId, traceId: 'trace-browser-message-reply-slot' },
            route: { topicId: 'app.ask', contextId: 'room-1', resourceId: 'resource-1' },
            payload: { typeId: 'app.ask.v1', resource: '{"answer":42}' },
            actions: { corrId: REQUEST_ID, replyToMsgId: REQUEST_ID }
        },
        receivedAtEpochMs: 0,
        reply: vi.fn()
    };
}
