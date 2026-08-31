import { createBrowserWebSocketInbox } from '@shared-web/browser/websocket/browser-websocket-inbox.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

const testMessage: ALMessage = {
    id: {
        v: 2,
        msgId: 'message-1',
        ts: 1,
        senderId: 'sender-1'
    },
    route: {
        topicId: 'test.message',
        contextId: 'test-context',
        resourceId: 'test-resource'
    },
    payload: {
        typeId: 'test.message',
        contentType: 'application/json',
        resource: '{}'
    }
};

describe('Browser WebSocket inbox', () => {
    it('multiplexes one WebSocket callback and dispatches handlers in order', async () => {
        const events: string[] = [];
        const subscriptionEvents: string[] = [];
        const middleware = createDefaultApiMiddlewareTestDouble();
        let onMessage: ((message: ALMessage) => Promise<void>) | undefined;
        vi.mocked(
            middleware.middleware.webSocketQueueBox.onAnyInboxMessageDo
        ).mockImplementation((_id, callbacks) => {
            subscriptionEvents.push('attached');
            onMessage = async (message) => {
                await callbacks.onMessage(
                    message,
                    toResourceEntry('test.message', '{}')
                );
            };
            return middleware.middleware.webSocketQueueBox;
        });
        vi.mocked(
            middleware.middleware.webSocketQueueBox.removeAnyInboxMessageCallback
        ).mockImplementation(() => {
            subscriptionEvents.push('removed');
            return true;
        });
        const inbox = createBrowserWebSocketInbox({
            readMiddleware: () => middleware
        });

        const stopMessages = inbox.subscribe({
            id: 'messages',
            order: 20,
            onMessage: async () => {
                events.push('messages');
            }
        });
        const stopState = inbox.subscribe({
            id: 'state-events',
            order: 10,
            onMessage: async () => {
                events.push('state-events');
            }
        });

        expect(subscriptionEvents).toEqual(['attached']);
        await onMessage?.(testMessage);
        expect(events).toEqual(['state-events', 'messages']);

        stopState();
        expect(subscriptionEvents).toEqual(['attached']);
        stopMessages();
        expect(subscriptionEvents).toEqual(['attached', 'removed']);
    });
});
