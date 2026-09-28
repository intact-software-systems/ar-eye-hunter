import { describe, expect, it, onTestFinished } from 'vitest';

import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type { LiveWsNotice, LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { createGroupSnapshot } from '../../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

describe('Rallar server WS live cluster publication', () => {
    it('publishes once from a socketless owner and sends on the remote socket owner', async () => {
        const subscribers: Array<(notice: LiveWsNotice) => Promise<void> | void> = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                for (const subscriber of subscribers) {
                    await subscriber(notice);
                }
            },
            subscribe: async (_channel, onNotice) => {
                subscribers.push(onNotice);
            }
        };
        const sent: string[] = [];
        await installLiveWsNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-b',
            nowMs: () => 100,
            inboundStores: [],
            resolveBroadRecipientSessionIds: () => ['remote-session'],
            filterEligibleRecipientSessionIds: (ids) => ids,
            sendToTargetsWithResult: (message, ids) => {
                sent.push(`${message.id.msgId}:${ids.join(',')}`);
            }
        });
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            { text: 'hello' }
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('cluster-published');
        expect(result.sentCount).toBeUndefined();
        expect(sent).toEqual([`${message.id.msgId}:remote-session`]);
    });

    it('refuses explicit live-only publication when effective delivery requires durable outbound work', async () => {
        let notices = 0;
        const transport: LiveWsNoticeTransport = {
            publish: async () => {
                notices += 1;
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.durable', 'message', 'all'),
            'all',
            'app.durable.v1',
            { text: 'hello' }
        );

        const result = await router.publish({
            message: { ...message, qos: { delivery: { algo: 'at-least-once' }, durability: { algo: 'local-outbox' } } },
            fanout: 'live-only'
        });

        expect(result.status).toBe('failed');
        expect(result.reason).toContain('durable');
        expect(notices).toBe(0);
    });

    it('reports a failed cluster publication instead of remote success', async () => {
        const transport: LiveWsNoticeTransport = {
            publish: async () => {
                throw new Error('notify failed');
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            { text: 'hello' }
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('failed');
        expect(result.reason).toContain('notify failed');
    });

    it('does not publish an already expired final message', async () => {
        let notices = 0;
        const transport: LiveWsNoticeTransport = {
            publish: async () => {
                notices += 1;
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const base = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        const result = await router.publish({
            message: { ...base, constraints: { expiresAtMs: 100 } },
            fanout: 'live-only'
        });

        expect(result.status).toBe('expired');
        expect(notices).toBe(0);
    });

    it('publishes the final transformed proxy message without invoking its receiver handler', async () => {
        let receiver: ((notice: LiveWsNotice) => Promise<void> | void) | undefined;
        const sent: string[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                await receiver?.(notice);
            },
            subscribe: async (_channel, onNotice) => {
                receiver = onNotice;
            }
        };
        await installLiveWsNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-b',
            nowMs: () => 100,
            inboundStores: [],
            resolveBroadRecipientSessionIds: () => ['remote-session'],
            filterEligibleRecipientSessionIds: (ids) => ids,
            sendToTargetsWithResult: (message) => {
                sent.push(message.route.topicId);
            }
        });
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            defaultFanout: 'none',
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        let finalHandlerRuns = 0;
        router.on({ topicId: 'app.final' }, () => {
            finalHandlerRuns += 1;
        });
        router.proxy({
            from: { topicId: 'app.source' },
            transform: (message) => ({
                ...message.raw,
                route: newALRoute('app.final', 'message', 'all'),
                payload: { typeId: 'app.final.v1', resource: '{}' }
            }),
            fanout: 'live-only',
            suppressDefaultFanout: true
        });
        const source = newALBroadcastMessage(
            'sender',
            newALRoute('app.source', 'message', 'all'),
            'all',
            'app.source.v1',
            {}
        );

        await router.route(source);

        expect(sent).toEqual(['app.final']);
        expect(finalHandlerRuns).toBe(0);
    });

    it('freezes the principal recipient IDs in a scoped inline notice', async () => {
        const notices: LiveWsNotice[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport,
                channel: 'ws-channel',
                publisherId: 'server-a',
                readPrincipalSessionIds: async () => ['remote-session']
            }
        });
        const principalRef = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'alice' };
        const base = newALBroadcastMessage('server-a', newALRoute('app.alert', 'message', 'all'), 'all', 'app.alert.v1', {});
        const message = { ...base, targets: { mode: 'broadcast' as const, scope: 'principal' as const, principalRef } };

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('cluster-published');
        expect(notices).toMatchObject([{
            scope: { applicationId: 'app-1', workspaceId: 'workspace-1' },
            audience: { mode: 'principal', principalRef, recipientSessionIds: ['remote-session'] }
        }]);
    });

    it('freezes a trusted server room audience before remote publication', async () => {
        const snapshot = createGroupSnapshot(2, ['remote-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const notices: LiveWsNotice[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport,
                channel: 'ws-channel',
                publisherId: 'server-a',
                readServerRoomAudience: async (message) => ({
                    targets: message.targets!,
                    sessions: snapshot.activeSessions,
                    snapshotVersion: 2
                })
            }
        });
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('cluster-published');
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            audience: { mode: 'room', groupRef, recipientSessionIds: ['remote-session'] }
        });
    });

    it('refuses a room publication when the supplied audience belongs to different final targets', async () => {
        const snapshot = createGroupSnapshot(2, ['remote-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const notices: LiveWsNotice[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport,
                channel: 'ws-channel',
                publisherId: 'server-a',
                readServerRoomAudience: async (message) => ({
                    targets: { ...message.targets!, exceptPeerIds: ['different'] },
                    sessions: snapshot.activeSessions,
                    snapshotVersion: 2
                })
            }
        });
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('failed');
        expect(notices).toEqual([]);
    });

    it('refuses durable room work when the publisher cannot authorize a frozen room audience', async () => {
        const snapshot = createGroupSnapshot(2, ['remote-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const outbox = new InMemoryQueueBox(new Map());
        const service = createDefaultWsQueueBoxServerService({
            outbox,
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport: { publish: async () => {}, subscribe: async () => {} },
                channel: 'ws-channel',
                publisherId: 'server-a',
                readServerRoomAudience: async () => undefined
            }
        });
        const base = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );
        const message = {
            ...base,
            qos: { durability: { algo: 'local-outbox' as const }, ack: { algo: 'hop' as const } }
        };

        const result = await router.publish({ message, fanout: 'outbox' });

        expect(result.status).toBe('failed');
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('uses a canonical inbound key for an oversized admitted room publication', async () => {
        const snapshot = createGroupSnapshot(2, ['remote-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const notices: LiveWsNotice[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            authorizeRoomMessage: ({ message }) => ({
                authorized: true,
                audience: { targets: message.targets!, sessions: snapshot.activeSessions, snapshotVersion: 2 }
            }),
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const base = newALBroadcastMessage(
            'sender',
            newALRoute('room.match', 'message', groupRef.groupId),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef }
        );
        const message = {
            ...base,
            constraints: { expiresAtMs: 10_000 },
            payload: { ...base.payload, resource: JSON.stringify('x'.repeat(64_000)) }
        };

        await router.route(message, {
            kind: 'ws-client',
            peerId: 'sender',
            authenticatedScope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupRecipientPeerIds: ['remote-session']
        });

        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            delivery: 'inbound-key',
            audienceMode: 'room',
            inbound: { reference: { senderId: 'sender', msgId: message.id.msgId } }
        });
    });
});
