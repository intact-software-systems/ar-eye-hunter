import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import assert from 'node:assert/strict';
import { createDisabledQueuePubSubBridge, createLocalQueuePubSubBridge, createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';

interface CreateQueueBoxPubSubMessageOptions {
    readonly publisherId: string;
}

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
    const receivedByA: JsonWireValue[] = [];
    const receivedByB: JsonWireValue[] = [];

    await localA.subscribe('ws-channel', (message) => {
        receivedByA.push(message);
    });
    await localB.subscribe('ws-channel', (message) => {
        receivedByB.push(message);
    });

    const messageFromA = createMessage({ publisherId: 'publisher-a' });
    await localA.publish('ws-channel', messageFromA);
    assert.deepEqual(receivedByA, []);
    assert.deepEqual(receivedByB, [messageFromA]);

    const messageFromB = createMessage({ publisherId: 'publisher-b' });
    await localB.publish('ws-channel', messageFromB);
    assert.deepEqual(receivedByA, [messageFromB]);
    assert.deepEqual(receivedByB, [messageFromA]);
});

Deno.test('local queue pub/sub bridge isolates channels', async () => {
    const bus = createLocalQueuePubSubBus();
    const bridge = createLocalQueuePubSubBridge({ bus });
    const received: JsonWireValue[] = [];

    await bridge.subscribe('expected-channel', (message) => {
        received.push(message);
    });
    await bridge.publish('other-channel', createMessage({ publisherId: 'remote' }));

    assert.deepEqual(received, []);
});

Deno.test('local queue pub/sub bridge keeps independently composed buses isolated', async () => {
    const publisher = createLocalQueuePubSubBridge({
        bus: createLocalQueuePubSubBus()
    });
    const isolated = createLocalQueuePubSubBridge({
        bus: createLocalQueuePubSubBus()
    });
    const received: JsonWireValue[] = [];

    await isolated.subscribe('ws-channel', (message) => {
        received.push(message);
    });
    await publisher.publish('ws-channel', createMessage({ publisherId: 'remote' }));

    assert.deepEqual(received, []);
});

Deno.test('disabled queue pub/sub bridge does not publish or subscribe', async () => {
    const bridge = createDisabledQueuePubSubBridge();
    const received: JsonWireValue[] = [];

    await bridge.subscribe('ws-channel', (message) => {
        received.push(message);
    });
    await bridge.publish('ws-channel', createMessage({ publisherId: 'remote' }));

    assert.deepEqual(received, []);
});

function createMessage(
    options: CreateQueueBoxPubSubMessageOptions
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
        delivery: 'entry',
        payload: JSON.stringify({ ok: true })
    };
}
