import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageSubscriptions } from '@shared-web/browser/messages/browser-rallar-message-subscriptions.ts';
import { BrowserRallarSubscriptionScope } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarMessage } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageReplySender } from '@shared-web/browser/messages/to-rallar-message.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import type {
    BrowserWebSocketInbox,
    BrowserWebSocketInboxHandler
} from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { describe, expect, it, vi } from 'vitest';

describe('browser Rallar message subscriptions', () => {
    it('cleans subscription scopes once and immediately cleans late additions', () => {
        const calls: string[] = [];
        const subscriptions = new BrowserRallarSubscriptionScope();
        subscriptions.add(() => calls.push('first'));
        subscriptions.add(undefined);
        subscriptions.add(() => calls.push('second'));

        expect(subscriptions.size()).toBe(2);
        subscriptions.unsubscribe();
        subscriptions.unsubscribe();
        subscriptions.add(() => calls.push('late'));

        expect(calls).toEqual(['first', 'second', 'late']);
        expect(subscriptions.size()).toBe(0);
    });

    it('allows RTC subscriptions to use topic and type selectors', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            { topicId: 'room.chat', typeId: 'chat.message.v1' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('accepts an RTC string selector as canonical typeId shorthand', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.rtc.onMessage(
            'chat.message.v1',
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('rejects RTC topic-only subscriptions because the low-level callback is type keyed', () => {
        const facade = createRallarFacade();

        expect(() => facade.messages.rtc.onMessage({ topicId: 'room.chat' }, vi.fn())).toThrow('RTC message subscriptions require a typeId.');
    });

    it('allows WS topic-only subscriptions', () => {
        const facade = createRallarFacade();

        const unsubscribe = facade.messages.ws.onMessage(
            { topicId: 'room.chat' },
            vi.fn()
        );

        expect(unsubscribe).toEqual(expect.any(Function));
        unsubscribe();
    });

    it('delivers a WS message with a reply that sends through the messaging reply path', async () => {
        const fixture = createSubscriptionsFixture();
        const received: RallarMessage<{ text: string; }>[] = [];
        fixture.subscriptions.subscribe<{ text: string; }>('ws', 'app.ask.v1', (message) => {
            received.push(message);
        });
        const request = toWsMessage('request-1', undefined);

        await fixture.deliver(request);
        await received[0].reply({ answer: 42 }, { ttlMs: 5_000 });

        expect(received.map((message) => message.payload)).toEqual([{ text: 'hello' }]);
        expect(fixture.sendReply).toHaveBeenCalledWith(request, { answer: 42 }, { ttlMs: 5_000 });
    });

    it('never hands a reply to a WS subscriber of its type: the reply inbox owns it', async () => {
        const fixture = createSubscriptionsFixture();
        const received: string[] = [];
        fixture.subscriptions.subscribe('ws', 'app.ask.v1', (message) => {
            received.push(message.raw.id.msgId);
        });

        await fixture.deliver(toWsMessage('reply-1', 'request-1'));
        await fixture.deliver(toWsMessage('message-2', undefined));

        expect(received).toEqual(['message-2']);
    });
});

interface SubscriptionsFixture {
    readonly subscriptions: BrowserRallarMessageSubscriptions;
    readonly sendReply: ReturnType<typeof vi.fn<RallarMessageReplySender>>;
    deliver(message: ALMessage): Promise<void>;
}

function createSubscriptionsFixture(): SubscriptionsFixture {
    const handlers = new Map<string, BrowserWebSocketInboxHandler>();
    const wsInbox: BrowserWebSocketInbox = {
        subscribe: (handler) => {
            handlers.set(handler.id, handler);
            return () => handlers.delete(handler.id);
        },
        attach: () => {},
        detach: () => {},
        isAttached: () => true
    };
    const registry = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const sendReply = vi.fn<RallarMessageReplySender>(async (request) => await Promise.resolve(registry.open(request, 'ws')));
    const subscriptions = new BrowserRallarMessageSubscriptions({
        wsInbox,
        sendReply,
        readMiddleware: () => undefined
    });
    return {
        subscriptions,
        sendReply,
        deliver: async (message) => {
            for (const handler of handlers.values()) {
                await handler.onMessage(message);
            }
        }
    };
}

function toWsMessage(msgId: string, replyToMsgId: string | undefined): ALMessage {
    return {
        id: { v: 3, msgId, ts: 0, senderId: 'peer-1' },
        route: { topicId: 'app.ask', contextId: 'world', resourceId: 'resource-1' },
        payload: { typeId: 'app.ask.v1', resource: JSON.stringify({ text: 'hello' }) },
        ...(replyToMsgId === undefined ? {} : { actions: { corrId: replyToMsgId, replyToMsgId } })
    };
}
