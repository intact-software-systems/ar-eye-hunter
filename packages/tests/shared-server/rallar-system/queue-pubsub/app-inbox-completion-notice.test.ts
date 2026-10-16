import { describe, expect, it, vi } from 'vitest';

import {
    createAppInboxCompletionRelay,
    decodeAppInboxCompletionNotice,
    installAppInboxCompletionNoticeSubscriber,
    type AppInboxCompletionNotice,
    type AppInboxCompletionNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';
import { ResourceInboxCompletionNotifications } from '@shared/queuebox/resource-inbox/resource-inbox-completion-notifications.ts';

const KEY = { topicId: 'app-inbox.client-state', resourceId: 'request-1', contextId: 'context-1' };

describe('AppInbox completion notices', () => {
    it('wakes a waiter on the other instance and never takes its own notice back', async () => {
        const transport = createMemoryTransport();
        const owner = ResourceInboxCompletionNotifications.createDefault();
        const handler = ResourceInboxCompletionNotifications.createDefault(
            createAppInboxCompletionRelay({ transport, channel: 'app-inbox-completion', publisherId: 'server-b' })
        );
        const acceptOwner = vi.spyOn(owner, 'acceptRelayed');
        const acceptHandler = vi.spyOn(handler, 'acceptRelayed');
        await installAppInboxCompletionNoticeSubscriber({
            transport,
            channel: 'app-inbox-completion',
            publisherId: 'server-a',
            notifications: owner
        });
        await installAppInboxCompletionNoticeSubscriber({
            transport,
            channel: 'app-inbox-completion',
            publisherId: 'server-b',
            notifications: handler
        });
        const subscription = owner.subscribe(KEY);
        const woken = subscription.wait(60_000);

        handler.publish(KEY, 'awaitable');
        await woken;

        expect(transport.published).toEqual([{
            kind: 'app-inbox-completion',
            version: 1,
            channel: 'app-inbox-completion',
            publisherId: 'server-b',
            key: KEY
        }]);
        expect(acceptOwner).toHaveBeenCalledWith(KEY);
        expect(acceptHandler).not.toHaveBeenCalled();
        subscription.close();
    });

    it('decodes only an exact notice on the expected channel', () => {
        const notice = { kind: 'app-inbox-completion', version: 1, channel: 'c', publisherId: 'p', key: { ...KEY, contextId: null } };
        expect(decodeAppInboxCompletionNotice(notice, 'c')).toEqual(notice);
        expect(decodeAppInboxCompletionNotice(notice, 'other')).toBeUndefined();
        expect(decodeAppInboxCompletionNotice({ ...notice, extra: true }, 'c')).toBeUndefined();
        expect(decodeAppInboxCompletionNotice({ ...notice, publisherId: '' }, 'c')).toBeUndefined();
        expect(decodeAppInboxCompletionNotice({ ...notice, key: { ...KEY, contextId: 1 } }, 'c')).toBeUndefined();
        expect(decodeAppInboxCompletionNotice({ ...notice, key: { ...KEY, resourceId: 'x'.repeat(8_000) } }, 'c'))
            .toBeUndefined();
    });

    it('drops a notice whose publication fails, leaving the waiter its safety tick', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const relay = createAppInboxCompletionRelay({
            transport: {
                publish: async () => {
                    throw new Error('notify failed');
                },
                subscribe: async () => {}
            },
            channel: 'app-inbox-completion',
            publisherId: 'server-b'
        });

        expect(() => relay(KEY)).not.toThrow();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
        warn.mockRestore();
    });
});

function createMemoryTransport(): AppInboxCompletionNoticeTransport & { readonly published: AppInboxCompletionNotice[]; } {
    const published: AppInboxCompletionNotice[] = [];
    const subscribers: Array<(notice: AppInboxCompletionNotice) => Promise<void> | void> = [];
    return {
        published,
        publish: async (notice) => {
            published.push(notice);
            for (const subscriber of subscribers) {
                await subscriber(notice);
            }
        },
        subscribe: async (_channel, onNotice) => {
            subscribers.push(onNotice);
        }
    };
}
