import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import assert from 'node:assert/strict';
import { createPostgresQueuePubSubBridge } from '../../src/db/create-postgres-queue-pub-sub-bridge.ts';

interface RecordedPostgresNotification {
    readonly channel: string;
    readonly message: object;
}

interface CreateQueueBoxPubSubMessageOptions {
    readonly channel?: string;
    readonly publisherId: string;
}

Deno.test('postgres queue pub/sub bridge publishes key-only envelopes', async () => {
    const notifications: RecordedPostgresNotification[] = [];
    const bridge = createPostgresQueuePubSubBridge({
        notify: (channel, message) => {
            notifications.push({ channel, message });
            return Promise.resolve();
        },
        listen: async () => {
        }
    });

    await bridge.publish(
        'ws-channel',
        createMessage({
            publisherId: 'publisher-local'
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
        typeId: 'WS_OUTBOX',
        delivery: 'key',
        expiresAtMs: 1_800_000_000_000
    });
    assert.equal('payload' in notifications[0].message, false);
});

Deno.test('postgres queue pub/sub bridge forwards JSON wire values and rejects invalid JSON', async () => {
    const received: JsonWireValue[] = [];
    const accepted = createMessage({
        channel: 'ws-channel',
        publisherId: 'publisher-remote'
    });
    const unexpected = { ...accepted, unexpected: true };
    const bridge = createPostgresQueuePubSubBridge({
        notify: () => Promise.resolve(),
        listen: async (_channel, onMessage) => {
            await onMessage('not-json');
            await onMessage('{"channel":"ws-channel"}');
            await onMessage(JSON.stringify(unexpected));
            await onMessage(JSON.stringify(accepted));
        }
    });

    await bridge.subscribe('ws-channel', (message) => {
        received.push(message);
    });

    assert.deepEqual(received, [{ channel: 'ws-channel' }, unexpected, accepted]);
});

function createMessage(
    options: CreateQueueBoxPubSubMessageOptions
): QueueBoxPubSubMessage {
    return {
        key: {
            topicId: 'topic',
            resourceId: 'resource-1',
            contextId: 'context'
        },
        channel: options.channel ?? 'ws-channel',
        publisherId: options.publisherId,
        typeId: 'WS_OUTBOX',
        delivery: 'key',
        expiresAtMs: 1_800_000_000_000
    };
}

Deno.test('postgres queue pub/sub bridge rejects notices outside the wire budget before notify', async () => {
    let notified = false;
    const bridge = createPostgresQueuePubSubBridge({
        notify: async () => {
            notified = true;
        },
        listen: async () => {}
    });
    await assert.rejects(() => bridge.publish('ws-channel', createMessage({ publisherId: 'p'.repeat(8_000) })));
    assert.equal(notified, false);
});
