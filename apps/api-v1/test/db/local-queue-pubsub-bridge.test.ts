import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/pubsub/QueueBoxPubSubBridge.ts';
import assert from 'node:assert/strict';
import { createDisabledQueuePubSubBridge, createLocalQueuePubSubBridge, createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';

Deno.test('local queue pub/sub bridge delivers messages across publishers on the same bus', async () => {
    const bus = createLocalQueuePubSubBus();
    const localA = createLocalQueuePubSubBridge({
        ignoredPublisherId: 'publisher-a',
        bus
    });
    const localB = createLocalQueuePubSubBridge({
        ignoredPublisherId: 'publisher-b',
        bus
    });
    const receivedByA: QueueBoxPubSubMessage[] = [];
    const receivedByB: QueueBoxPubSubMessage[] = [];

    await localA.subscribe('ws-channel', (message) => {
        receivedByA.push(message);
    });
    await localB.subscribe('ws-channel', (message) => {
        receivedByB.push(message);
    });

    await localA.publish('ws-channel', createMessage({ publisherId: 'publisher-a' }));
    assert.equal(receivedByA.length, 0);
    assert.equal(receivedByB.length, 1);

    await localB.publish('ws-channel', createMessage({ publisherId: 'publisher-b' }));
    assert.equal(receivedByA.length, 1);
    assert.equal(receivedByB.length, 1);
});

Deno.test('local queue pub/sub bridge isolates channels', async () => {
    const bus = createLocalQueuePubSubBus();
    const bridge = createLocalQueuePubSubBridge({ bus });
    const received: QueueBoxPubSubMessage[] = [];

    await bridge.subscribe('expected-channel', (message) => {
        received.push(message);
    });
    await bridge.publish('other-channel', createMessage({ publisherId: 'remote' }));

    assert.deepEqual(received, []);
});

Deno.test('disabled queue pub/sub bridge does not publish or subscribe', async () => {
    const bridge = createDisabledQueuePubSubBridge();
    const received: QueueBoxPubSubMessage[] = [];

    await bridge.subscribe('ws-channel', (message) => {
        received.push(message);
    });
    await bridge.publish('ws-channel', createMessage({ publisherId: 'remote' }));

    assert.deepEqual(received, []);
});

function createMessage(
    options: Readonly<{ publisherId: string; }>
): QueueBoxPubSubMessage {
    return {
        key: {
            topicId: 'topic',
            resourceId: crypto.randomUUID(),
            contextId: 'context'
        },
        channel: 'ws-channel',
        publisherId: options.publisherId,
        typeId: 'WS_INBOX',
        payload: JSON.stringify({ ok: true })
    };
}
