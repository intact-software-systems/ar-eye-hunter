import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installLiveWsNoticeSubscriber } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type { LiveWsNotice, LiveWsNoticeTransport } from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { RallarServerWsRoomAuthorizer } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/websocket/ws-topic-room-authorizer.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshot } from '../../group-state/snapshot/group-state-snapshot-test-fixtures.ts';

const SCOPE = { applicationId: 'app-1', workspaceId: 'workspace-1' };

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
            sendToTargetsWithResult: ({ message, recipientSessionIds }) => {
                sent.push(`${message.id.msgId}:${recipientSessionIds.join(',')}`);
            }
        });
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
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

    it.each(['all', 'world'] as const)(
        'does not locally send a %s notice to an open socket without current authentication',
        async (targetMode) => {
            const socket = new JsonWebSocketServer();
            const native = new TestWebSocket('ws://stale');
            native.open();
            socket.addConnection(new ConnectionContext({ id: 'stale-session', socket: native }));
            const service = createDefaultWsQueueBoxServerService({
                outbox: new InMemoryQueueBox(new Map()),
                socket,
                name: 'server-a',
                readAuthenticatedConnectionScope: () => undefined,
                targetResolver: {
                    resolveBroadcastRecipients: () => [{ peerId: 'stale-session', connectionId: 'stale-session' }]
                }
            });
            onTestFinished(() => service.dispose());
            let notices = 0;
            const router = new RallarServerWsRouter(service, {
                nowEpochMs: () => 100,
                livePublication: {
                    transport: {
                        publish: async () => {
                            notices += 1;
                        },
                        subscribe: async () => {}
                    },
                    channel: 'ws-channel',
                    publisherId: 'server-a'
                }
            });
            const message = newALBroadcastMessage(
                'server-a',
                newALRoute('app.live', 'message', targetMode),
                targetMode,
                'app.live.v1',
                {}
            );

            const result = await router.publish({
                message,
                fanout: 'live-only',
                ...(targetMode === 'world' ? { scope: { applicationId: 'app-1', workspaceId: 'workspace-1' } } : {})
            });

            expect(result.status).toBe('cluster-published');
            expect(notices).toBe(1);
            expect(native.sent).toEqual([]);
        }
    );

    it('publishes an explicit live-only message whose QoS asks for durable work as one notice', async () => {
        const notices: LiveWsNotice[] = [];
        const transport: LiveWsNoticeTransport = {
            publish: async (notice) => {
                notices.push(notice);
            },
            subscribe: async () => {}
        };
        const outbox = new InMemoryQueueBox(new Map());
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            outbox,
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
            newALRoute('app.durable', 'message', 'all'),
            'all',
            'app.durable.v1',
            { text: 'hello' }
        );
        const message = {
            ...base,
            qos: { delivery: { algo: 'at-least-once' as const }, durability: { algo: 'local-outbox' as const } }
        };

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result).toMatchObject({ fanout: 'live-only', status: 'cluster-published' });
        expect(result.reason).toBeUndefined();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ delivery: 'inline', message: { id: message.id, qos: message.qos } });
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('reports a failed cluster publication instead of remote success', async () => {
        const transport: LiveWsNoticeTransport = {
            publish: async () => {
                throw new Error('notify failed');
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
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

    it('reports failed admitted live publication without retrying the best-effort notice', async () => {
        let attempts = 0;
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            defaultFanout: 'live-only',
            livePublication: {
                transport: {
                    publish: async () => {
                        attempts += 1;
                        throw new Error('notify unavailable');
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        onTestFinished(() => error.mockRestore());
        const message = newALBroadcastMessage(
            'sender',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        await expect(router.route(message)).resolves.toBeUndefined();

        expect(attempts).toBe(1);
        expect(error).toHaveBeenCalledWith(
            `Rallar server WS admitted publication failed for ${message.route.topicId} (${message.id.msgId}): notify unavailable`
        );
    });

    it('reports failed proxy live publication without retrying the best-effort notice', async () => {
        let attempts = 0;
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            defaultFanout: 'none',
            livePublication: {
                transport: {
                    publish: async () => {
                        attempts += 1;
                        throw new Error('proxy notify unavailable');
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
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
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        onTestFinished(() => error.mockRestore());
        const source = newALBroadcastMessage(
            'sender',
            newALRoute('app.source', 'message', 'all'),
            'all',
            'app.source.v1',
            {}
        );

        await expect(router.route(source)).resolves.toBeUndefined();

        expect(attempts).toBe(1);
        expect(error).toHaveBeenCalledWith(
            `Rallar server WS proxy publication failed for app.final (${source.id.msgId}): proxy notify unavailable`
        );
    });

    it('reports successful publication with a local failure diagnostic after the notice was published', async () => {
        let notices = 0;
        const transport: LiveWsNoticeTransport = {
            publish: async () => {
                notices += 1;
            },
            subscribe: async () => {}
        };
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        vi.spyOn(service, 'sendToTargetsWithResult').mockImplementation(() => {
            throw new Error('local socket diagnostics failed');
        });
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(notices).toBe(1);
        expect(result.status).toBe('cluster-published');
        expect(result.reason).toContain('local socket diagnostics failed');
    });

    it('retains normal local socket failure details after successful cluster publication', async () => {
        class FailingWebSocket extends TestWebSocket {
            override send(): void {
                throw new Error('socket send failed');
            }
        }
        const socket = new JsonWebSocketServer();
        const native = new FailingWebSocket('ws://local');
        native.open();
        socket.addConnection(new ConnectionContext({ id: 'local-session', socket: native }));
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            readAuthenticatedConnectionScope: () => ({
                scope: { applicationId: 'app', workspaceId: 'space' },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }),
            targetResolver: {
                resolveBroadcastRecipients: () => [{ peerId: 'local-session', connectionId: 'local-session' }]
            }
        });
        onTestFinished(() => service.dispose());
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        onTestFinished(() => error.mockRestore());
        let notices = 0;
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport: {
                    publish: async () => {
                        notices += 1;
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(notices).toBe(1);
        expect(result.status).toBe('cluster-published');
        expect(result.sentCount).toBeUndefined();
        expect(result.reason).toContain('1/1 local recipients');
        expect(result.reason).toContain('socket send failed');
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
            readAuthenticatedConnectionScope: () => undefined,
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

    it('does not locally send after transport returns past a provider-only notice deadline', async () => {
        let nowMs = 100;
        const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
        onTestFinished(() => dateNow.mockRestore());
        const socket = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://local');
        native.open();
        socket.addConnection(new ConnectionContext({ id: 'local-session', socket: native }));
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            qosProvider: {
                defaultsForMessage: () => ({ expiry: { algo: 'expires-at', opts: { expiresAtMs: 200 } } })
            },
            readAuthenticatedConnectionScope: () => ({
                scope: { applicationId: 'app', workspaceId: 'space' },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }),
            targetResolver: {
                resolveBroadcastRecipients: () => [{ peerId: 'local-session', connectionId: 'local-session' }]
            }
        });
        onTestFinished(() => service.dispose());
        const notices: LiveWsNotice[] = [];
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => nowMs,
            livePublication: {
                transport: {
                    publish: async (notice) => {
                        notices.push(notice);
                        nowMs = 201;
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('cluster-published');
        expect(notices).toHaveLength(1);
        expect(notices[0]?.expiresAtMs).toBe(200);
        expect(native.sent).toEqual([]);
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
            sendToTargetsWithResult: ({ message }) => {
                sent.push(message.route.topicId);
            }
        });
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
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
            readAuthenticatedConnectionScope: () => undefined,
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

    it('publishes a world notice with the scope it reaches and sends it here to the live connections of that scope alone', async () => {
        const notices: LiveWsNotice[] = [];
        const fixture = createScopedSocketsFixture(notices);
        const message = newALBroadcastMessage('server-a', newALRoute('app.live', 'message', 'world'), 'world', 'app.live.v1', {});

        const result = await fixture.router.publish({ message, fanout: 'live-only', scope: SCOPE });

        expect(result.status).toBe('cluster-published');
        expect(notices).toMatchObject([{ scope: SCOPE, audience: { mode: 'broad', targetMode: 'world' } }]);
        expect(fixture.sockets.get('in-scope')!.sent).toHaveLength(1);
        expect(fixture.sockets.get('foreign')!.sent).toEqual([]);
    });

    it.each(['live-only', 'outbox', 'none'] as const)('fails a %s world publication that names no scope and publishes nothing', async (fanout) => {
        const notices: LiveWsNotice[] = [];
        const fixture = createScopedSocketsFixture(notices);
        const message = newALBroadcastMessage('server-a', newALRoute('app.live', 'message', 'world'), 'world', 'app.live.v1', {});

        const result = await fixture.router.publish({ message, fanout });

        expect(result).toMatchObject({
            status: 'failed',
            reason: 'A world publication requires the application and workspace scope it reaches'
        });
        expect(notices).toEqual([]);
        expect(fixture.sockets.get('in-scope')!.sent).toEqual([]);
    });

    it('publishes an admitted principal broadcast in a room as a principal notice naming the room sessions of that principal', async () => {
        const base = createGroupSnapshot(2, ['bob-session', 'carol-1', 'carol-2']);
        const snapshot = {
            ...base,
            activeSessions: base.activeSessions.map((session) => session.sessionId === 'carol-2' ? { ...session, principalId: 'principal-carol-1' } : session)
        };
        const groupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: snapshot.group.groupId };
        const notices: LiveWsNotice[] = [];
        const fixture = createScopedSocketsFixture(
            notices,
            createGroupRoomWsAuthorizer({
                readGroupSnapshot: () => snapshot,
                readPreActivationAppData: () => 'allowed',
                nowEpochMs: () => 100
            })
        );
        const roomMessage = newALBroadcastMessage('bob-session', newALRoute('room.match', groupRef.groupId, 'tick-1'), 'room', 'room.match.v1', {}, {
            groupRef
        });
        const principalRef = { applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-carol-1' };
        const message = { ...roomMessage, targets: { mode: 'broadcast' as const, scope: 'principal' as const, groupRef, principalRef } };

        await fixture.router.route(message, { kind: 'ws-client', peerId: 'bob-session', authenticatedScope: SCOPE });

        expect(notices).toMatchObject([{
            scope: SCOPE,
            audience: { mode: 'principal', principalRef, recipientSessionIds: ['carol-1', 'carol-2'] }
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
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            readServerPublishAudience: async (message) => ({
                targets: message.targets!,
                sessions: snapshot.activeSessions,
                snapshotVersion: 2
            }),
            livePublication: {
                transport,
                channel: 'ws-channel',
                publisherId: 'server-a'
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

    it('keeps a local server room send inside the frozen scope after a session reconnects elsewhere', async () => {
        const snapshot = createGroupSnapshot(2, ['room-session', 'reconnected-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const socket = new JsonWebSocketServer();
        const roomSocket = new TestWebSocket('ws://room');
        const reconnectedSocket = new TestWebSocket('ws://other-workspace');
        roomSocket.open();
        reconnectedSocket.open();
        socket.addConnection(new ConnectionContext({ id: 'room-session', socket: roomSocket }));
        socket.addConnection(new ConnectionContext({ id: 'reconnected-session', socket: reconnectedSocket }));
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            readAuthenticatedConnectionScope: (connection) => ({
                scope: {
                    applicationId: groupRef.applicationId,
                    workspaceId: connection.id === 'room-session' ? groupRef.workspaceId : 'other-workspace'
                },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            }),
            targetResolver: {
                resolveBroadcastRecipients: () => [
                    { peerId: 'room-session', connectionId: 'room-session' },
                    { peerId: 'reconnected-session', connectionId: 'reconnected-session' }
                ]
            }
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            readServerPublishAudience: async (message) => ({
                targets: message.targets!,
                sessions: snapshot.activeSessions,
                snapshotVersion: 2
            })
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

        expect(result.status).toBe('sent-live');
        expect(roomSocket.sent).toHaveLength(1);
        expect(reconnectedSocket.sent).toEqual([]);
    });

    it('does not send the locally frozen room ID to a same-ID connection in another workspace', async () => {
        const snapshot = createGroupSnapshot(2, ['local-session']);
        const groupRef = {
            applicationId: snapshot.group.applicationId,
            workspaceId: snapshot.group.workspaceId,
            groupId: snapshot.group.groupId
        };
        const socket = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://local');
        native.open();
        socket.addConnection(new ConnectionContext({ id: 'local-session', socket: native }));
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            readAuthenticatedConnectionScope: () => ({
                scope: { applicationId: groupRef.applicationId, workspaceId: 'other' },
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            })
        });
        onTestFinished(() => service.dispose());
        let notices = 0;
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            readServerPublishAudience: async (message) => ({
                targets: message.targets!,
                sessions: snapshot.activeSessions,
                snapshotVersion: 2
            }),
            livePublication: {
                transport: {
                    publish: async () => {
                        notices += 1;
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
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
        expect(notices).toBe(1);
        expect(native.sent).toEqual([]);
    });

    it('rechecks the connection generation after recipient resolution and before socket send', async () => {
        const socket = new JsonWebSocketServer();
        const oldNative = new TestWebSocket('ws://old');
        const newNative = new TestWebSocket('ws://new');
        oldNative.open();
        newNative.open();
        socket.addConnection(new ConnectionContext({ id: 'same-session', socket: oldNative, generationId: 'old' }));
        const scope = { applicationId: 'app', workspaceId: 'space' };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            readAuthenticatedConnectionScope: () => ({ scope, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }),
            targetResolver: {
                resolveBroadcastRecipients: () => [{ peerId: 'same-session', connectionId: 'same-session' }]
            }
        });
        onTestFinished(() => service.dispose());
        const originalEncode = socket.encode.bind(socket);
        vi.spyOn(socket, 'encode').mockImplementation((message) => {
            socket.addConnection(new ConnectionContext({ id: 'same-session', socket: newNative, generationId: 'new' }));
            return originalEncode(message);
        });
        let notices = 0;
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            livePublication: {
                transport: {
                    publish: async () => {
                        notices += 1;
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
        });
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('cluster-published');
        expect(notices).toBe(1);
        expect(oldNative.sent).toEqual([]);
        expect(newNative.sent).toEqual([]);
    });

    it('checks the current authenticated principal before a fixed local session send', () => {
        const socket = new JsonWebSocketServer();
        const native = new TestWebSocket('ws://principal');
        native.open();
        socket.addConnection(new ConnectionContext({ id: 'principal-session', socket: native }));
        const scope = { applicationId: 'app', workspaceId: 'space' };
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket,
            name: 'server-a',
            readAuthenticatedConnectionScope: () => ({
                scope,
                principalId: 'other-principal',
                expiresAtEpochMs: Number.MAX_SAFE_INTEGER
            })
        });
        onTestFinished(() => service.dispose());
        const message = newALBroadcastMessage(
            'server-a',
            newALRoute('app.live', 'message', 'all'),
            'all',
            'app.live.v1',
            {}
        );

        service.sendToTargetsWithResult({
            message,
            recipientSessionIds: ['principal-session'],
            recipientScope: scope,
            recipientPrincipalId: 'intended-principal',
            requireAuthenticatedRecipient: true
        });

        expect(native.sent).toEqual([]);
    });

    it('refuses durable room work with only a bare room ID and no full group reference', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
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
                publisherId: 'server-a'
            }
        });
        const base = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', 'room-1'),
            'room',
            'room.match.v1',
            { tick: 1 }
        );
        const message = {
            ...base,
            qos: { durability: { algo: 'local-outbox' as const }, ack: { algo: 'hop' as const } }
        };

        const result = await router.publish({ message, fanout: 'outbox' });

        expect(result.status).toBe('failed');
        expect(result.reason).toContain('full group reference');
        expect(await outbox.getAllKeys()).toEqual([]);
    });

    it('returns a failed public result when the room audience reader rejects', async () => {
        const service = createDefaultWsQueueBoxServerService({
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            readServerPublishAudience: async () => {
                throw new TypeError('snapshot unavailable');
            },
            livePublication: {
                transport: { publish: async () => {}, subscribe: async () => {} },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
        });
        const message = newALBroadcastMessage(
            'game-server',
            newALRoute('room.match', 'message', 'room-1'),
            'room',
            'room.match.v1',
            { tick: 1 },
            { groupRef: { applicationId: 'app', workspaceId: 'space', groupId: 'room-1' } }
        );

        const result = await router.publish({ message, fanout: 'live-only' });

        expect(result.status).toBe('failed');
        expect(result.reason).toContain('snapshot unavailable');
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
            readAuthenticatedConnectionScope: () => undefined,
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            readServerPublishAudience: async (message) => ({
                targets: { ...message.targets!, exceptPeerIds: ['different'] },
                sessions: snapshot.activeSessions,
                snapshotVersion: 2
            }),
            livePublication: {
                transport,
                channel: 'ws-channel',
                publisherId: 'server-a'
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
            readAuthenticatedConnectionScope: () => undefined,
            outbox,
            socket: new JsonWebSocketServer(),
            name: 'server-a'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            nowEpochMs: () => 100,
            readServerPublishAudience: async () => undefined,
            livePublication: {
                transport: { publish: async () => {}, subscribe: async () => {} },
                channel: 'ws-channel',
                publisherId: 'server-a'
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
            readAuthenticatedConnectionScope: () => undefined,
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

interface ScopedSocketsFixture {
    readonly router: RallarServerWsRouter;
    readonly sockets: ReadonlyMap<string, TestWebSocket>;
}

/** A router over two authenticated sockets, `in-scope` in app-1/workspace-1 and `foreign` in another application. */
function createScopedSocketsFixture(
    notices: LiveWsNotice[],
    authorizeRoomMessage?: RallarServerWsRoomAuthorizer
): ScopedSocketsFixture {
    const socket = new JsonWebSocketServer();
    const sockets = new Map<string, TestWebSocket>();
    for (const sessionId of ['in-scope', 'foreign']) {
        const native = new TestWebSocket(`ws://${sessionId}`);
        native.open();
        socket.addConnection(new ConnectionContext({ id: sessionId, socket: native }));
        sockets.set(sessionId, native);
    }
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        name: 'server-a',
        readAuthenticatedConnectionScope: (connection) => ({
            scope: connection.id === 'foreign' ? { ...SCOPE, applicationId: 'app-2' } : SCOPE,
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER
        }),
        targetResolver: {
            resolveBroadcastRecipients: () => [...sockets.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    const router = new RallarServerWsRouter(service, {
        authorizeRoomMessage,
        nowEpochMs: () => 100,
        livePublication: {
            transport: {
                publish: async (notice) => {
                    notices.push(notice);
                },
                subscribe: async () => {}
            },
            channel: 'ws-channel',
            publisherId: 'server-a'
        }
    });
    return { router, sockets };
}
