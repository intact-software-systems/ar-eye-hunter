import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import assert from 'node:assert/strict';
import { queuePubSubDeliveryForConfig } from '../../src/db/api-v1-queue-pubsub-bridge.ts';
import { createPostgresQueuePubSubBridge } from '../../src/db/postgres-queue-pubsub-bridge.ts';

Deno.test('api-v1 queue pub/sub config uses key delivery only for postgres', () => {
    assert.equal(queuePubSubDeliveryForConfig({ mode: 'postgres' }), 'key');
    assert.equal(queuePubSubDeliveryForConfig({ mode: 'local' }), 'entry');
    assert.equal(queuePubSubDeliveryForConfig({ mode: 'disabled' }), 'entry');
});

Deno.test('postgres queue pub/sub bridge publishes key-only envelopes', async () => {
    const notifications: Array<
        Readonly<{
            channel: string;
            message: QueueBoxPubSubMessage;
        }>
    > = [];
    const bridge = createPostgresQueuePubSubBridge('publisher-local', {
        notify: (channel, message) => {
            notifications.push({ channel, message });
            return Promise.resolve();
        },
        startListening: async () => {
        }
    });

    await bridge.publish(
        'ws-channel',
        createMessage({
            publisherId: 'publisher-local',
            payload: 'x'.repeat(16_000)
        })
    );

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].channel, 'ws-channel');
    assert.deepEqual(notifications[0].message, {
        key: {
            topicId: 'topic',
            resourceId: 'resource-1',
            contextId: 'context'
        },
        channel: 'ws-channel',
        publisherId: 'publisher-local',
        typeId: 'WS_INBOX',
        delivery: 'key'
    });
    assert.equal('payload' in notifications[0].message, false);
});

Deno.test('postgres queue pub/sub bridge ignores malformed and wrong-channel payloads', async () => {
    const received: QueueBoxPubSubMessage[] = [];
    const bridge = createPostgresQueuePubSubBridge('publisher-local', {
        notify: () => Promise.resolve(),
        startListening: async (_channel, options) => {
            await options.onMessage({ channel: 'ws-channel' } as QueueBoxPubSubMessage);
            await options.onMessage(
                createMessage({
                    channel: 'other-channel',
                    publisherId: 'publisher-remote'
                })
            );
            await options.onMessage(
                createMessage({
                    channel: 'ws-channel',
                    publisherId: 'publisher-remote',
                    delivery: 'key',
                    payload: undefined
                })
            );
        }
    });

    await bridge.subscribe('ws-channel', (message) => {
        received.push(message);
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].delivery, 'key');
    assert.equal(received[0].channel, 'ws-channel');
});

function createMessage(
    options: Readonly<{
        channel?: string;
        publisherId: string;
        delivery?: 'entry' | 'key';
        payload?: string;
    }>
): QueueBoxPubSubMessage {
    const base = {
        key: {
            topicId: 'topic',
            resourceId: 'resource-1',
            contextId: 'context'
        },
        channel: options.channel ?? 'ws-channel',
        publisherId: options.publisherId,
        typeId: 'WS_INBOX'
    };

    if (options.delivery === 'key') {
        return {
            ...base,
            delivery: 'key'
        };
    }

    return {
        ...base,
        delivery: 'entry',
        payload: options.payload ?? JSON.stringify({ ok: true })
    };
}
