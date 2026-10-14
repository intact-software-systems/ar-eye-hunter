import assert from 'node:assert/strict';

import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type { LiveWsNotice } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createApiV1LiveWsNoticeTransport } from '../../src/db/api-v1-live-ws-notice-transport.ts';
import { createApiV1QueuePubSubBridge } from '../../src/db/api-v1-queue-pubsub-bridge.ts';
import { createLocalQueuePubSubBus } from '../../src/db/local-queue-pubsub-bridge.ts';
import { rememberAuthorisedWsConnection } from '../../src/runtime/rtc-topology/authorised-ws-connection-registry.ts';
import { filterEligibleLiveWsSessionIds } from '../../src/services/filter-eligible-live-ws-session-ids.ts';

const notice: LiveWsNotice = {
    kind: 'live-ws',
    version: 1,
    channel: 'ws-channel',
    publisherId: 'publisher-a',
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    expiresAtMs: 1_800_000_000_000,
    delivery: 'inbound-key',
    audienceMode: 'peer',
    inbound: { namespace: 'ws', reference: { senderId: 'sender', msgId: 'message' } }
};

Deno.test('local live notice transport shares its mode family and skips the publisher subscriber', async () => {
    const bus = createLocalQueuePubSubBus();
    const received: LiveWsNotice[] = [];
    const publisher = createApiV1LiveWsNoticeTransport({
        mode: 'local',
        publisherId: 'publisher-a',
        notification: null,
        localBus: bus,
        nowMs: () => 1
    });
    const receiver = createApiV1LiveWsNoticeTransport({
        mode: 'local',
        publisherId: 'publisher-b',
        notification: null,
        localBus: bus,
        nowMs: () => 1
    });
    await publisher.subscribe('ws-channel', (value) => {
        received.push(value);
    });
    await receiver.subscribe('ws-channel', (value) => {
        received.push(value);
    });
    await publisher.publish(notice);
    const { scope: _scope, ...unscoped } = notice;
    const broad: LiveWsNotice = { ...unscoped, audienceMode: 'broad', targetMode: 'all' };
    await publisher.publish(broad);
    assert.deepEqual(received, [notice, broad]);
});

Deno.test('disabled live notice transport does not claim a receiving callback', async () => {
    const transport = createApiV1LiveWsNoticeTransport({
        mode: 'disabled',
        publisherId: 'publisher-a',
        notification: null,
        localBus: createLocalQueuePubSubBus(),
        nowMs: () => 1
    });
    let received = false;
    await transport.subscribe('ws-channel', () => {
        received = true;
    });
    await transport.publish(notice);
    assert.equal(received, false);
});

Deno.test('PostgreSQL QueueBox and live notice subscribers coexist on one notification port', async () => {
    const listeners: Array<(payload: string) => void | Promise<void>> = [];
    const notification = {
        notify: async () => {},
        listen: (_channel: string, callback: (payload: string) => void | Promise<void>) => {
            listeners.push(callback);
            return Promise.resolve();
        }
    };
    const bus = createLocalQueuePubSubBus();
    const queue = createApiV1QueuePubSubBridge({ mode: 'postgres', publisherId: 'publisher-b', notification, localBus: bus });
    const live = createApiV1LiveWsNoticeTransport({
        mode: 'postgres',
        publisherId: 'publisher-b',
        notification,
        localBus: bus,
        nowMs: () => 1
    });
    const queueReceived: JsonWireValue[] = [];
    const liveReceived: LiveWsNotice[] = [];
    await queue.subscribe('ws-channel', (value) => {
        queueReceived.push(value);
    });
    await live.subscribe('ws-channel', (value) => {
        liveReceived.push(value);
    });
    assert.equal(listeners.length, 2);
    for (const listener of listeners) {
        await listener(JSON.stringify(notice));
    }
    assert.deepEqual(queueReceived, [notice]);
    assert.deepEqual(liveReceived, [notice]);
});

Deno.test('a separate local receiver sends only to its currently authenticated addressed socket', async () => {
    const bus = createLocalQueuePubSubBus();
    const publisher = createApiV1LiveWsNoticeTransport({
        mode: 'local',
        publisherId: 'publisher-a',
        notification: null,
        localBus: bus,
        nowMs: () => 1
    });
    const receiver = createApiV1LiveWsNoticeTransport({
        mode: 'local',
        publisherId: 'publisher-b',
        notification: null,
        localBus: bus,
        nowMs: () => 1
    });
    const socketServer = new JsonWebSocketServer();
    socketServer.connections.set(
        'remote-session',
        new ConnectionContext({
            id: 'remote-session',
            socket: { readyState: WebSocket.OPEN } as WebSocket,
            generationId: 'generation',
            generationStartedAtEpochMs: 100
        })
    );
    rememberAuthorisedWsConnection('remote-session', 'generation', {
        authSession: {
            clientId: 'client',
            username: 'user',
            sessionId: 'remote-session',
            issuedAtEpochMs: 1,
            expiresAtEpochMs: 1_800_000_000_000
        },
        generationId: 'generation',
        generationStartedAtEpochMs: 100,
        scope: notice.scope,
        principalId: 'principal',
        clientInstanceId: 'instance',
        displayName: 'User',
        userAgent: null,
        platform: 'web',
        capabilities: [],
        expiresAtEpochMs: 1_800_000_000_000
    });
    const sent: string[] = [];
    await installLiveWsNoticeSubscriber({
        transport: receiver,
        channel: 'ws-channel',
        publisherId: 'publisher-b',
        nowMs: () => 1,
        inboundStores: [],
        resolveBroadRecipientSessionIds: () => [],
        filterEligibleRecipientSessionIds: (ids, incoming) =>
            filterEligibleLiveWsSessionIds({
                socketServer,
                candidateSessionIds: ids,
                notice: incoming,
                nowMs: 1
            }),
        sendToTargetsWithResult: ({ recipientSessionIds }) => {
            sent.push(...recipientSessionIds);
        }
    });
    const inline: LiveWsNotice = {
        kind: 'live-ws',
        version: 1,
        channel: 'ws-channel',
        publisherId: 'publisher-a',
        scope: notice.scope,
        expiresAtMs: 1_800_000_000_000,
        delivery: 'inline',
        audience: { mode: 'peer', recipientSessionIds: ['remote-session'] },
        message: {
            id: { v: 3, msgId: 'message', ts: 1, senderId: 'sender' },
            route: { topicId: 'room.match', resourceId: 'room', contextId: 'room' },
            targets: { mode: 'unicast', toPeerId: 'remote-session' },
            constraints: { expiresAtMs: 1_800_000_000_000 },
            payload: { typeId: 'room.match', resource: '{}' }
        }
    };
    await publisher.publish(inline);
    assert.deepEqual(sent, ['remote-session']);
});
