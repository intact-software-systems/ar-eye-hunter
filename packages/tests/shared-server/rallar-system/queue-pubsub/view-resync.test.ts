import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import { writeViewResync } from '@shared-server/rallar-system/websocket/write-view-resync.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';
import { describe, expect, it, onTestFinished } from 'vitest';
import { attachTestWebSocket } from '../../../shared/websocket/attach-test-web-socket.ts';
import { TestWebSocket } from '../../../shared/websocket/test-web-socket.ts';

// LISTEN readiness must invalidate reads even when no new notification arrives after a subscriber reconnects.
describe('view recovery after a subscriber loses notifications', () => {
    it.each(['durable', 'live'] as const)('sends resync over an unchanged authenticated socket after the %s subscriber reconnects', async (kind) => {
        const socket = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://alice');
        const unauthenticated = new TestWebSocket('ws://anonymous');
        native.open();
        unauthenticated.open();
        const connection = new ConnectionContext({ id: 'alice', socket: native });
        attachTestWebSocket(socket, connection);
        attachTestWebSocket(socket, new ConnectionContext({ id: 'anonymous', socket: unauthenticated }));
        const service = createDefaultWsQueueBoxServerService({
            name: 'server-b',
            socket,
            inboundVolatileStores: undefined,
            outbox: new InMemoryQueueBox(new Map()),
            readAuthenticatedConnectionScope: (current) =>
                current.id === 'alice'
                    ? {
                        scope: { applicationId: 'game', workspaceId: 'default' },
                        principalId: 'alice',
                        expiresAtEpochMs: Date.now() + 60000
                    }
                    : undefined
        });
        onTestFinished(() => service.dispose());
        const ready: Array<() => void> = [];
        let generation = 0;
        const onSubscribed = () => writeViewResync(service, { messageId: `ready-${++generation}`, createdAtEpochMs: Date.now() });
        if (kind === 'live') {
            await installLiveWsNoticeSubscriber({
                transport: {
                    publish: async () => undefined,
                    subscribe: async (_channel, _onMessage, onSubscribed) => {
                        if (onSubscribed !== undefined) {
                            ready.push(onSubscribed);
                        }
                    }
                },
                channel: 'live',
                publisherId: 'server-b',
                nowMs: Date.now,
                inboundStores: [],
                onSubscribed,
                resolveBroadRecipientSessionIds: () => [],
                filterEligibleRecipientSessionIds: (ids) => ids,
                sendToTargetsWithResult: () => undefined
            });
        }
        else {
            await installQueueBoxPubSubBridge({
                bridge: {
                    publish: async () => undefined,
                    subscribe: async (_channel, _onMessage, onSubscribed) => {
                        if (onSubscribed !== undefined) {
                            ready.push(onSubscribed);
                        }
                    }
                },
                wsQBoxServerService: service,
                channel: 'durable',
                publisherId: 'server-b',
                onSubscribed
            });
        }
        ready[0]!();
        expect(native.sent).toHaveLength(1);
        // Another process commits while this listener is disconnected; no new event follows its reconnection.
        ready[0]!();
        expect(native.sent).toHaveLength(2);
        expect(socket.connections.get('alice')).toBe(connection);
        expect(native.sent.map((value) => JSON.parse(value).payload)).toEqual([
            { typeId: 'view.resync', contentType: 'application/json', resource: '{"version":1}' },
            { typeId: 'view.resync', contentType: 'application/json', resource: '{"version":1}' }
        ]);
        expect(unauthenticated.sent).toEqual([]);
    });
});
