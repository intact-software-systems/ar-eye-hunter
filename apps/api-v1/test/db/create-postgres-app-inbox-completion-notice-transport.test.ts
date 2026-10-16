import assert from 'node:assert/strict';

import type { AppInboxCompletionNotice } from '@shared-server/rallar-system/queue-pubsub/app-inbox-completion-notice.ts';

import type { ApiV1DatabaseNotificationPort } from '../../src/db/api-v1-database-lifecycle.ts';
import {
    API_V1_APP_INBOX_COMPLETION_CHANNEL,
    createApiV1AppInboxCompletionNotices,
    createPostgresAppInboxCompletionNoticeTransport
} from '../../src/db/create-postgres-app-inbox-completion-notice-transport.ts';

interface RecordingNotificationPort extends ApiV1DatabaseNotificationPort {
    readonly notified: Array<{ readonly channel: string; readonly message: object; }>;
    readonly listeners: Array<(payload: string) => void | Promise<void>>;
}

const NOTICE: AppInboxCompletionNotice = {
    kind: 'app-inbox-completion',
    version: 1,
    channel: API_V1_APP_INBOX_COMPLETION_CHANNEL,
    publisherId: 'server-b',
    key: { topicId: 'app-inbox.client-state', resourceId: 'request-1', contextId: 'context-1' }
};

Deno.test('AppInbox completion notices exist only for PostgreSQL pub/sub', () => {
    const notification = createRecordingNotificationPort();
    for (const mode of ['local', 'disabled'] as const) {
        assert.equal(createApiV1AppInboxCompletionNotices({ mode, notification, publisherId: 'server-b' }), undefined);
    }
    const postgres = createApiV1AppInboxCompletionNotices({ mode: 'postgres', notification, publisherId: 'server-b' });
    assert.equal(postgres?.channel, API_V1_APP_INBOX_COMPLETION_CHANNEL);
    assert.equal(postgres?.publisherId, 'server-b');
    assert.throws(
        () => createApiV1AppInboxCompletionNotices({ mode: 'postgres', notification: null, publisherId: 'server-b' }),
        TypeError
    );
});

Deno.test('the PostgreSQL completion transport notifies the notice and delivers only decodable payloads', async () => {
    const notification = createRecordingNotificationPort();
    const transport = createPostgresAppInboxCompletionNoticeTransport(notification);
    const received: AppInboxCompletionNotice[] = [];
    await transport.subscribe(API_V1_APP_INBOX_COMPLETION_CHANNEL, (notice) => {
        received.push(notice);
    });

    await transport.publish(NOTICE);
    const [listener] = notification.listeners;
    assert.ok(listener);
    await listener('not json');
    await listener(JSON.stringify({ ...NOTICE, channel: 'ws-channel' }));
    await listener(JSON.stringify(NOTICE));

    assert.deepEqual(notification.notified, [{ channel: API_V1_APP_INBOX_COMPLETION_CHANNEL, message: NOTICE }]);
    assert.deepEqual(received, [NOTICE]);
});

function createRecordingNotificationPort(): RecordingNotificationPort {
    const notified: RecordingNotificationPort['notified'] = [];
    const listeners: RecordingNotificationPort['listeners'] = [];
    return {
        notified,
        listeners,
        notify: (channel, message) => {
            notified.push({ channel, message });
            return Promise.resolve();
        },
        listen: (_channel, onMessage) => {
            listeners.push(onMessage);
            return Promise.resolve();
        }
    };
}
