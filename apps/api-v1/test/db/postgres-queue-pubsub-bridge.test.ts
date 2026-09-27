import assert from 'node:assert/strict';

import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { encodeLiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';

import { createPostgresLiveWsNoticeTransport } from '../../src/db/create-postgres-live-ws-notice-transport.ts';
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

Deno.test('postgres live WS transport publishes and receives a validated inline notice', async () => {
    const published: object[] = [];
    const received: object[] = [];
    const notice = {
        kind: 'live-ws' as const,
        version: 1 as const,
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        expiresAtMs: 1_800_000_000_000,
        audience: { mode: 'peer' as const, recipientSessionIds: ['session-1'] },
        delivery: 'inline' as const,
        message: {
            id: { v: 2 as const, msgId: 'message-1', ts: 1, senderId: 'sender' },
            route: { topicId: 'room.match', resourceId: 'room', contextId: 'room' },
            targets: { mode: 'unicast' as const, toPeerId: 'session-1' },
            constraints: { expiresAtMs: 1_800_000_000_000 },
            payload: { typeId: 'room.match', resource: '{}' }
        }
    };
    const transport = createPostgresLiveWsNoticeTransport({
        notify: async (_channel, message) => {
            published.push(message);
        },
        listen: async (_channel, onMessage) => {
            await onMessage('not-json');
            await onMessage(JSON.stringify({ ...notice, scope: { applicationId: '', workspaceId: 'workspace' } }));
            await onMessage(JSON.stringify(notice));
        }
    }, () => 1);

    await transport.publish(notice);
    await transport.subscribe('ws-channel', (receivedNotice) => {
        received.push(receivedNotice);
    });

    assert.deepEqual(published, [notice]);
    assert.deepEqual(received, [notice]);
});

Deno.test('postgres live WS transport refuses expired and oversized notices before notify', async () => {
    let notified = false;
    const transport = createPostgresLiveWsNoticeTransport({
        notify: async () => {
            notified = true;
        },
        listen: async () => {}
    }, () => 1_800_000_000_000);
    const expired = {
        kind: 'live-ws' as const,
        version: 1 as const,
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        expiresAtMs: 1_800_000_000_000,
        audienceMode: 'room' as const,
        delivery: 'inbound-key' as const,
        inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message-1' } }
    };
    await assert.rejects(() => transport.publish(expired));
    await assert.rejects(() => transport.publish({ ...expired, expiresAtMs: 1_800_000_000_001, publisherId: 'p'.repeat(8_000) }));
    assert.equal(notified, false);
});

Deno.test('postgres live WS transport publishes the exact JSON-clean builder notice', async () => {
    const sent: string[] = [];
    const transport = createPostgresLiveWsNoticeTransport({
        notify: async (_channel, notice) => {
            sent.push(JSON.stringify(notice));
        },
        listen: async () => {}
    }, () => 1);
    const built = newALBroadcastMessage('server', newALRoute('room.match', 'world', 'resource'), 'all', 'room.match', { text: 'hello' });
    const encoded = encodeLiveWsNotice({
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope: { applicationId: 'app', workspaceId: 'workspace' },
        expiresAtMs: 1_800_000_000_000,
        audience: { mode: 'broad', targetMode: 'all' },
        message: built
    });
    assert.equal(encoded.kind, 'inline');
    if (encoded.kind !== 'inline') {
        throw new Error('Expected inline notice');
    }
    await transport.publish(encoded.notice);
    assert.deepEqual(sent, [encoded.serialized]);
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
