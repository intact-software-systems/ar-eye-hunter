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
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

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
        expect(fixture.diagnostics).toEqual([]);
    });

    it('drops a reply that arrives over RTC with a payload-free diagnostic, since replies travel over WS', async () => {
        const fixture = createSubscriptionsFixture();
        const received: string[] = [];
        fixture.subscriptions.subscribe('rtc', 'app.ask.v1', (message) => {
            received.push(message.raw.id.msgId);
        });

        await fixture.deliverRtc(toWsMessage('reply-1', 'request-1'));

        expect(received).toEqual([]);
        expect(fixture.diagnostics).toEqual([{
            kind: 'reply-late',
            msgId: 'reply-1',
            replyToMsgId: 'request-1',
            typeId: 'app.ask.v1',
            senderId: 'peer-1',
            carrier: 'rtc',
            cause: 'unobserved',
            traceId: 'trace-browser-rallar-message-subscriptions',
            corrId: 'request-1'
        }]);
    });
});

interface SubscriptionsFixture {
    readonly subscriptions: BrowserRallarMessageSubscriptions;
    readonly sendReply: ReturnType<typeof vi.fn<RallarMessageReplySender>>;
    readonly diagnostics: ALInboundRuntimeDiagnosticsEvent[];
    deliver(message: ALMessage): Promise<void>;
    deliverRtc(message: ALMessage): Promise<void>;
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
    const middleware = createDefaultApiMiddlewareTestDouble();
    const rtcCallbacks: Parameters<typeof middleware.middleware.rtcRxStreamer.onInboxMessageDo>[1][] = [];
    vi.mocked(middleware.middleware.rtcRxStreamer.onInboxMessageDo).mockImplementation((_typeId, callback) => {
        rtcCallbacks.push(callback);
        return middleware.middleware.rtcRxStreamer;
    });
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const subscriptions = new BrowserRallarMessageSubscriptions({
        wsInbox,
        sendReply,
        readMiddleware: () => middleware,
        readInboundDiagnostics: () => (event) => diagnostics.push(event)
    });
    return {
        subscriptions,
        sendReply,
        diagnostics,
        deliver: async (message) => {
            for (const handler of handlers.values()) {
                await handler.onMessage(message);
            }
        },
        deliverRtc: async (message) => {
            for (const callback of rtcCallbacks) {
                await callback.onMessage(message, toResourceEntry(message.payload.typeId, {}));
            }
        }
    };
}

function toWsMessage(msgId: string, replyToMsgId: string | undefined): ALMessage {
    return {
        id: { v: 4, msgId, ts: 0, senderId: 'peer-1', traceId: 'trace-browser-rallar-message-subscriptions' },
        route: { topicId: 'app.ask', contextId: 'world', resourceId: 'resource-1' },
        payload: { typeId: 'app.ask.v1', resource: JSON.stringify({ text: 'hello' }) },
        ...(replyToMsgId === undefined ? {} : { actions: { corrId: replyToMsgId, replyToMsgId } })
    };
}
