import assert from 'node:assert/strict';

import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { createApiV1WsLivePublication } from '../../src/composition/create-api-v1-ws-live-publication.ts';
import type { ApiV1DatabaseNotificationPort } from '../../src/db/api-v1-database-lifecycle.ts';
import { API_V1_LIVE_WS_NOTICE_CHANNEL, createApiV1LiveWsNoticeTransport } from '../../src/db/api-v1-live-ws-notice-transport.ts';
import { API_V1_QUEUE_BOX_KEY_CHANNEL, createApiV1QueuePubSubBridge } from '../../src/db/api-v1-queue-pubsub-bridge.ts';
import { API_V1_APP_INBOX_COMPLETION_CHANNEL } from '../../src/db/create-postgres-app-inbox-completion-notice-transport.ts';
import { API_V1_RELAYED_ACK_CHANNEL, createApiV1RelayedAckNotices } from '../../src/db/create-postgres-relayed-ack-notice-transport.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';

/** NOTIFY as PostgreSQL routes it: a payload reaches only the listeners of its own channel. */
function createChannelRoutingNotificationPort(): ApiV1DatabaseNotificationPort {
    const listeners = new Map<string, ((payload: string) => void | Promise<void>)[]>();
    return {
        notify: async (channel, message) => {
            for (const listener of listeners.get(channel) ?? []) {
                await listener(JSON.stringify(message));
            }
        },
        listen: async (channel, onMessage) => {
            listeners.set(channel, [...(listeners.get(channel) ?? []), onMessage]);
        }
    };
}

Deno.test('each pub/sub notice kind has a channel of its own', () => {
    const channels = [
        API_V1_QUEUE_BOX_KEY_CHANNEL,
        API_V1_LIVE_WS_NOTICE_CHANNEL,
        API_V1_RELAYED_ACK_CHANNEL,
        API_V1_APP_INBOX_COMPLETION_CHANNEL
    ];
    assert.equal(new Set(channels).size, channels.length);
    const relayed = createApiV1RelayedAckNotices({
        mode: 'postgres',
        notification: createChannelRoutingNotificationPort(),
        publisherId: 'server-a'
    });
    assert.equal(relayed?.channel, API_V1_RELAYED_ACK_CHANNEL);
});

Deno.test('a live signalling notice reaches the live subscriber of another server and never the QueueBox key listener', async () => {
    const notification = createChannelRoutingNotificationPort();
    const queueBoxMessages: QueueBoxPubSubMessage[] = [];
    await createApiV1QueuePubSubBridge({
        mode: 'postgres',
        publisherId: 'server-b',
        notification,
        localBus: createLocalQueuePubSubBus()
    }).subscribe(API_V1_QUEUE_BOX_KEY_CHANNEL, (message) => {
        queueBoxMessages.push(message as QueueBoxPubSubMessage);
    });
    const liveNotices: LiveWsNotice[] = [];
    await createApiV1LiveWsNoticeTransport({
        mode: 'postgres',
        publisherId: 'server-b',
        notification,
        localBus: createLocalQueuePubSubBus(),
        nowMs: () => 100
    }).subscribe(API_V1_LIVE_WS_NOTICE_CHANNEL, (notice) => {
        liveNotices.push(notice);
    });
    const publication = createApiV1WsLivePublication({
        mode: 'postgres',
        notification,
        nowEpochMs: () => 100,
        readClientSnapshot: async () => undefined
    });
    assert.ok(publication);

    await publication.transport.publish({
        kind: 'live-ws',
        version: 1,
        channel: publication.channel,
        publisherId: 'server-a',
        delivery: 'inbound-key',
        expiresAtMs: 200,
        audienceMode: 'broad',
        targetMode: 'all',
        inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'signal' } }
    });

    assert.equal(liveNotices.length, 1);
    assert.deepEqual(queueBoxMessages, []);
});
