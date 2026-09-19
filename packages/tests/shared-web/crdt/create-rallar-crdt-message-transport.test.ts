import type { RallarCrdtMessageTransport } from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import { createRallarCrdtMessageTransport } from '@shared-web/browser/crdt/create-rallar-crdt-message-transport.ts';
import type { RallarMessage, RallarMessageHandler } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessagesOperations } from '@shared-web/browser/messages/rallar-message-operations.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageDelivery, type MessageDeliveryFixture } from '../messages/test-message-delivery.ts';

const payload = { operations: ['one'] };
const sendInput = { topicId: 'crdt', typeId: 'update', payload };

function createTransport(delivery: MessageDeliveryFixture): RallarCrdtMessageTransport {
    const messages: RallarMessagesOperations = {
        ws: { send: async () => delivery.handle, onMessage: () => () => {} },
        rtc: { send: async () => delivery.handle, onMessage: () => () => {} },
        channel: () => {
            throw new Error('Not a typed channel test');
        },
        room: () => {
            throw new Error('Not a room test');
        }
    };
    return createRallarCrdtMessageTransport(messages);
}

describe('built-in CRDT message admission', () => {
    afterEach(() => vi.useRealTimers());

    it.each(['ws', 'rtc'] as const)('preserves %s typed payload and releases the receive subscription', async (carrier) => {
        const delivery = createMessageDelivery(carrier, undefined);
        const unsubscribe = vi.fn();
        const onMessage = vi.fn<RallarMessagesOperations['ws']['onMessage']>(() => unsubscribe);
        const messages: RallarMessagesOperations = {
            ws: { send: async () => delivery.handle, onMessage },
            rtc: { send: async () => delivery.handle, onMessage },
            channel: () => {
                throw new Error('Not a channel test');
            },
            room: () => {
                throw new Error('Not a room test');
            }
        };
        const received: Array<typeof payload> = [];
        const stop = createRallarCrdtMessageTransport(messages)[carrier]!.onMessage<typeof payload>(
            { topicId: 'crdt', typeId: 'update' },
            (message) => {
                received.push(message.payload);
            }
        );
        const listener = onMessage.mock.calls[0][1] as RallarMessageHandler<typeof payload>;
        const message: RallarMessage<typeof payload> = {
            transport: carrier,
            typeId: 'update',
            topicId: 'crdt',
            senderId: 'peer',
            receivedAtEpochMs: 1,
            contextId: 'room',
            resourceId: 'update',
            payload,
            raw: {
                id: { v: 2, msgId: 'update', senderId: 'peer', ts: 1 },
                route: { topicId: 'crdt', contextId: 'room', resourceId: 'update' },
                payload: { typeId: 'update', contentType: 'application/json', resource: JSON.stringify(payload) }
            }
        };
        await listener(message);
        expect(received).toEqual([payload]);
        expect(received[0]).toBe(payload);
        expect(unsubscribe).not.toHaveBeenCalled();
        stop();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it.each(['ws', 'rtc'] as const)('waits for %s admission before reporting sent', async (carrier) => {
        const delivery = createMessageDelivery(carrier, undefined);
        const transport = createTransport(delivery);
        let completed = false;
        const sending = transport[carrier]!.send(sendInput).then((result) => {
            completed = true;
            return result;
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(completed).toBe(false);
        delivery.registry.record({
            kind: 'admission',
            carrier,
            msgId: delivery.handle.msgId,
            atMs: Date.now(),
            verdict: { kind: 'admitted', durable: true, queuedAttempts: 1 }
        });
        expect(await sending).toEqual({ transport: carrier, status: 'sent', reason: undefined });
    });

    it.each<ALDeliveryAdmissionVerdict>([
        { kind: 'refused', reason: 'unauthorized', detail: 'Access denied' },
        { kind: 'failed', detail: 'Storage failed' },
        { kind: 'superseded', detail: 'Replaced' }
    ])('reports $kind as failed with its reason', async (verdict) => {
        const delivery = createMessageDelivery('ws', verdict);
        expect(await createTransport(delivery).ws!.send(sendInput)).toEqual({
            transport: 'ws',
            status: 'failed',
            reason: 'detail' in verdict ? verdict.detail : undefined
        });
    });

    it('bounds a missing admission without marking the message failed', async () => {
        vi.useFakeTimers();
        const delivery = createMessageDelivery('ws', undefined);
        const sending = createTransport(delivery).ws!.send(sendInput);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await sending).toMatchObject({ status: 'failed' });
        expect(delivery.handle.lifecycle().state).toBe('submitted');
        expect(vi.getTimerCount()).toBe(0);
    });
});
