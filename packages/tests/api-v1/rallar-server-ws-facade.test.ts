import { describe, expect, it, vi } from 'vitest';
import {
    AL_CONTROL_NACK_TYPE_ID,
    type ALNackPayload,
    ALMessage,
    InMemoryQueueBox,
    newALBroadcastMessage,
    newALRoute,
    WsQueueBoxServerService,
    type WsServerTargetResolver,
} from '@shared/mod.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { createRallarServerFacade } from '@shared-server/rallar-facade/RallarServer.ts';
import { RallarServerWsFacade } from '@shared-server/rallar-facade/ws-topic-router.ts';
import { createGroupRoomWsAuthorizer } from '@shared-server/rallar-system/services/ws-topic-room-authorizer.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

describe('RallarServerWsFacade', () => {
    it('fans out implicit app topics to their declared targets', async () => {
        const { facade, socket } = createFacade();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.cursor', 'all', 'cursor-1'),
            'all',
            'cursor.position.v1',
            { x: 1, y: 2 },
            {
                exceptPeerIds: ['peer-1'],
            },
        );

        await facade.handle(message);

        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3',
        ]);
        expect(
            socket.sent.every((entry) => entry.data.id.msgId === message.id.msgId),
        ).toBe(true);
    });

    it('reserves rallar topics for system middleware and sends a NACK', async () => {
        const { facade, socket } = createFacade();
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('rallar.internal', 'all', 'secret-1'),
            'all',
            'internal.message.v1',
            { ok: false },
        );

        await facade.handle(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('uses lightweight validators for registered topics', async () => {
        const { facade, socket } = createFacade();
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            validate: (value) =>
                typeof value === 'object' && value !== null && 'title' in value,
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { done: true },
        );

        await facade.handle(message);

        expect(socket.sent).toHaveLength(1);
        expect(socket.sent[0].connectionId).toBe('conn-1');
        expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
    });

    it('dispatches registered handlers and allows default fanout to be disabled', async () => {
        const { facade, socket } = createFacade();
        const handler = vi.fn();
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'none',
            validate: () => true,
        });
        facade.on({ topicId: 'app.todo', typeId: 'todo.item.updated.v1' }, handler);
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Ship facade', done: false },
        );

        await facade.handle(message);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0].payload).toEqual({
            title: 'Ship facade',
            done: false,
        });
        expect(socket.sent).toHaveLength(0);
    });

    it('can route registered topics through the QueueBox outbox', async () => {
        const wakeOutbox = vi.fn();
        const { facade, service } = createFacade({ wakeOutbox });
        const enqueue = vi.spyOn(service, 'enqueueOutboxIfAbsent');
        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
            fanout: 'outbox',
        });
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('app.todo', 'all', 'todo-1'),
            'all',
            'todo.item.updated.v1',
            { title: 'Durable fanout', done: false },
            {
                reliability: 'at-least-once',
                ack: 'receiver',
            },
        );

        await facade.handle(message);

        expect(enqueue).toHaveBeenCalledWith(message);
        expect(wakeOutbox).toHaveBeenCalledOnce();
    });

    it('can require explicit topic definitions while still rejecting custom prefixes', async () => {
        const { facade } = createFacade({ allowImplicitUserTopics: false });

        facade.defineTopic({
            topicId: 'app.todo',
            typeId: 'todo.item.updated.v1',
        });

        expect(() =>
            facade.defineTopic({
                topicId: 'custom.todo',
                typeId: 'todo.item.updated.v1',
            })
        ).toThrow('Rallar user WS topic must start with app. or room.');
    });

    it('passes room broadcast target groupRef into room authorization context', async () => {
        const authorizeRoomMessage = vi.fn(() => true);
        const { facade } = createFacade({
            authorizeRoomMessage,
        });
        const group = createGroupSnapshot('room-1', ['peer-1'], 4).group;
        const message = newALBroadcastMessage(
            'peer-1',
            newALRoute('room.chat', 'room-1', 'msg-1'),
            'room',
            'chat.message.v1',
            { text: 'after join' },
            {
                groupRef: group,
                minSnapshotVersion: 4,
            },
        );

        await facade.handle(message);

        expect(authorizeRoomMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                roomId: 'room-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                },
                minSnapshotVersion: 4,
            }),
        );
    });

    it('rejects room messages as not-yet-in-sync when local cache is older than minSnapshotVersion', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { facade, socket } = createFacade({
                authorizeRoomMessage: createGroupRoomWsAuthorizer({
                    findGroupSnapshotById: () =>
                        createGroupSnapshot('room-1', ['peer-1'], 3),
                }),
            });
            const message = newALBroadcastMessage(
                'peer-1',
                newALRoute('room.chat', 'room-1', 'msg-1'),
                'room',
                'chat.message.v1',
                { text: 'after join' },
                {
                    minSnapshotVersion: 4,
                },
            );

            await facade.handle(message);

            expect(socket.sent).toHaveLength(1);
            expect(socket.sent[0].connectionId).toBe('conn-1');
            expect(socket.sent[0].data.payload.typeId).toBe(AL_CONTROL_NACK_TYPE_ID);
            const nack = JSON.parse(
                socket.sent[0].data.payload.resource,
            ) as ALNackPayload;
            expect(nack).toMatchObject({
                msgId: message.id.msgId,
                reason: 'not-yet-in-sync',
                serverSnapshotVersion: 3,
            });
            expect(nack).not.toHaveProperty('groupId');
            expect(nack).not.toHaveProperty('minSnapshotVersion');
            expect(nack).not.toHaveProperty('retryAfterMs');
        } finally {
            warn.mockRestore();
        }
    });
});

describe('RallarServer.ws.publish current behavior', () => {
    it('returns the live-only send count and sends to resolved targets', async () => {
        const { server, socket } = createServerFacade();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.cursor', 'all', 'cursor-1'),
            'all',
            'cursor.position.v1',
            { x: 1, y: 2 },
            {
                exceptPeerIds: ['peer-1'],
            },
        );

        const result = await server.ws.publish(message, 'live-only');

        expect(result).toMatchObject({
            fanout: 'live-only',
            status: 'sent-live',
            sentCount: 2,
            recipientCount: 2,
            failedCount: 0,
            entries: [],
        });
        expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
            'conn-2',
            'conn-3',
        ]);
        expect(
            socket.sent.every((entry) => entry.data.id.msgId === message.id.msgId),
        ).toBe(true);
    });

    it('returns 0 for live-only fanout with zero recipients', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            const { server, socket } = createServerFacade({
                targetResolver: {
                    ...createTargetResolver(),
                    resolveBroadcastRecipients: () => [],
                },
            });
            const message = newALBroadcastMessage(
                'server-1',
                newALRoute('app.cursor', 'all', 'cursor-1'),
                'all',
                'cursor.position.v1',
                { x: 1, y: 2 },
            );

            const result = await server.ws.publish(message, 'live-only');

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'no-recipients',
                sentCount: 0,
                recipientCount: 0,
                failedCount: 0,
                entries: [],
            });
            expect(socket.sent).toHaveLength(0);
            expect(warn).toHaveBeenCalledWith(
                'Dynamic WS topic had no recipients: app.cursor',
            );
        } finally {
            warn.mockRestore();
        }
    });

    it('returns partial-failure metadata for live-only send failures', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            const { server, socket } = createServerFacade({
                failingConnectionIds: ['conn-2'],
            });
            const message = newALBroadcastMessage(
                'server-1',
                newALRoute('app.cursor', 'all', 'cursor-1'),
                'all',
                'cursor.position.v1',
                { x: 1, y: 2 },
            );

            const result = await server.ws.publish(message, 'live-only');

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'partial-failure',
                sentCount: 2,
                recipientCount: 3,
                failedCount: 1,
                entries: [],
                failures: [
                    {
                        peerId: 'peer-2',
                        connectionId: 'conn-2',
                        reason: 'send failed',
                    },
                ],
            });
            expect(socket.sent.map((entry) => entry.connectionId).sort()).toEqual([
                'conn-1',
                'conn-3',
            ]);
        } finally {
            error.mockRestore();
        }
    });

    it('returns queued-outbox metadata for durable outbox fanout', async () => {
        const { server, service, socket, outbox, qboxEngine } = createServerFacade();
        const enqueue = vi.spyOn(service, 'enqueueOutboxIfAbsent');
        const groupRef = createGroupSnapshot('room-1', ['peer-1'], 1).group;
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-1'),
            'room',
            'todo.item.updated.v1',
            { title: 'Durable fanout', done: false },
            {
                groupRef,
                reliability: 'at-least-once',
                ack: 'receiver',
            },
        );

        const result = await server.ws.publish(message, 'outbox');
        const lowerResult = await enqueue.mock.results[0].value;

        expect(result).toMatchObject({
            fanout: 'outbox',
            status: 'queued-outbox',
            enqueueStatus: 'enqueued',
        });
        expect(enqueue).toHaveBeenCalledWith(message);
        expect(lowerResult.status).toBe('enqueued');
        expect(lowerResult.entries).toHaveLength(1);
        expect(result.entries).toHaveLength(1);
        expect((outbox as any).data.size).toBe(1);
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wake).toHaveBeenCalledOnce();
    });

    it('rejects a durable room broadcast before the router can queue an unscoped envelope', async () => {
        const { server, socket, outbox, qboxEngine } = createServerFacade();
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-invalid-room'),
            'room',
            'todo.item.updated.v1',
            { title: 'Invalid durable fanout', done: false },
            {
                reliability: 'at-least-once',
                ack: 'receiver',
            },
        );

        await expect(server.ws.publish(message, 'outbox')).rejects.toThrow(
            /room broadcast group ref/i,
        );

        expect(await outbox.getItem(message.route)).toBeUndefined();
        expect(socket.sent).toHaveLength(0);
        expect(qboxEngine.wake).not.toHaveBeenCalled();
    });

    it('returns none metadata without sending or enqueueing', async () => {
        const { server, service, socket, outbox } = createServerFacade();
        const enqueue = vi.spyOn(service, 'enqueueOutboxIfAbsent');
        const sendToTargets = vi.spyOn(service, 'sendToTargets');
        const message = newALBroadcastMessage(
            'server-1',
            newALRoute('app.todo', 'room-1', 'todo-1'),
            'room',
            'todo.item.updated.v1',
            { title: 'No fanout', done: false },
        );

        const result = await server.ws.publish(message, 'none');

        expect(result).toMatchObject({
            fanout: 'none',
            status: 'none',
            sentCount: 0,
            entries: [],
        });
        expect(enqueue).not.toHaveBeenCalled();
        expect(sendToTargets).not.toHaveBeenCalled();
        expect(socket.sent).toHaveLength(0);
        expect((outbox as any).data.size).toBe(0);
    });

    it('reports minimal server websocket status from current connections', () => {
        const { server, socket } = createServerFacade();
        socket.connections.set('conn-1', {
            id: 'conn-1',
            isOpen: true,
        });
        socket.connections.set('conn-2', {
            id: 'conn-2',
            isOpen: false,
        });

        expect(server.ws.status()).toEqual({
            transport: 'ws-server',
            connectionCount: 2,
            openConnectionCount: 1,
            connectionIds: ['conn-1', 'conn-2'],
            openConnectionIds: ['conn-1'],
            connections: [
                {
                    connectionId: 'conn-1',
                    isOpen: true,
                },
                {
                    connectionId: 'conn-2',
                    isOpen: false,
                },
            ],
        });
    });
});

function createFacade(
    options?: ConstructorParameters<typeof RallarServerWsFacade>[1],
) {
    const socket = createFakeWsServer();
    const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        socket as never,
        'server-1',
        {
            targetResolver: createTargetResolver(),
        },
    );
    const facade = new RallarServerWsFacade(service, options);

    return {
        facade,
        service,
        socket,
    };
}

function createServerFacade(
    options: Readonly<{
        targetResolver?: WsServerTargetResolver;
        failingConnectionIds?: readonly string[];
    }> = {},
) {
    const socket = createFakeWsServer({
        failingConnectionIds: options.failingConnectionIds,
    });
    const inbox = new InMemoryQueueBox(new Map());
    const outbox = new InMemoryQueueBox(new Map());
    const service = new WsQueueBoxServerService(
        inbox,
        outbox,
        socket as never,
        'server-1',
        {
            targetResolver: options.targetResolver ?? createTargetResolver(),
        },
    );
    const qboxEngine = {
        start: vi.fn(),
        wake: vi.fn(),
    };
    const server = createRallarServerFacade({
        runtime: {
            wsQBoxServerService: service,
            qboxEngine,
        },
    });

    return {
        server,
        service,
        socket,
        inbox,
        outbox,
        qboxEngine,
    };
}

function createFakeWsServer(
    options: Readonly<{
        failingConnectionIds?: readonly string[];
    }> = {},
) {
    const sent: Array<{ connectionId: string; data: ALMessage }> = [];
    const connections = new Map<string, { id: string; isOpen: boolean }>();
    const failingConnectionIds = new Set(options.failingConnectionIds ?? []);

    return {
        sent,
        connections,
        onMessageDo() {
            return this;
        },
        send(connectionId: string, data: ALMessage) {
            this.sendEncoded(connectionId, this.encode(data));
        },
        encode(data: ALMessage) {
            return {
                text: JSON.stringify(data),
                data,
            };
        },
        sendEncoded(
            connectionId: string,
            encoded: Readonly<{ text: string; data?: ALMessage }>,
        ) {
            if (failingConnectionIds.has(connectionId)) {
                throw new Error('send failed');
            }
            sent.push({
                connectionId,
                data: encoded.data ?? JSON.parse(encoded.text) as ALMessage,
            });
        },
    };
}

function createTargetResolver(): WsServerTargetResolver {
    const connectionIdByPeerId: Record<string, string> = {
        'peer-1': 'conn-1',
        'peer-2': 'conn-2',
        'peer-3': 'conn-3',
    };

    return {
        resolvePeerRecipients: (peerId: string) => {
            const connectionId = connectionIdByPeerId[peerId];
            return connectionId
                ? [
                    {
                        peerId,
                        connectionId,
                    },
                ]
                : [];
        },
        resolveBroadcastRecipients: () =>
            Object.entries(connectionIdByPeerId).map(([peerId, connectionId]) => ({
                peerId,
                connectionId,
            })),
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    snapshotVersion: number,
): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }
    return {
        stateRevision: snapshotVersion,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        group: createTestGroup({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            slug: groupId,
            displayName: groupId,
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(snapshotVersion, ownerPrincipalId),
        }),
        members: sessionIds.map((sessionId): GroupMember => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(snapshotVersion, ownerPrincipalId),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
        })),
        activeSessions: sessionIds.map((sessionId): GroupPresenceSession => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: snapshotVersion,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
