import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/PostgresSqlClient.ts';
import type { GroupTopologyGroupSnapshotReader } from '@shared-server/rallar-system/topology/group-topology-management-contracts.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-work.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import { createGroupTopologyOwners, type GroupTopologyOwners } from '@shared-server/rallar-system/topology/runtime/create-group-topology-owners.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/websocket/ws-system-topics.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    AppTopics,
    CircuitBreakerPolicy,
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALEventRoute,
    ResilienceDto,
    WsQueueBoxServerService,
    type ALMessage
} from '@shared/mod.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import { describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '../create-test-group.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('Rallar system websocket topics RTC topology', () => {
    it('does not run a process-local topology fallback for inbound group snapshots', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const peerSocket = new FakeSocket();
        const outsideSocket = new FakeSocket();

        server.addConnection(new ConnectionContext('session-a', senderSocket as never));
        server.addConnection(new ConnectionContext('session-b', peerSocket as never));
        server.addConnection(new ConnectionContext('session-c', outsideSocket as never));

        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        const topologyService = new RallarRtcTopologyService();
        const updateGroupTopology = vi.spyOn(topologyService, 'updateGroupTopology');
        initRallarSystemWsTopics(service, {
            rtcTopologyService: topologyService
        });

        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('session-a'),
            createClientSnapshot('session-b'),
            createClientSnapshot('session-c')
        ]);
        const message = newALBroadcastMessage(
            'session-a',
            newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-1'),
            'room',
            AppTopics.groupStateSnapshot,
            group,
            {
                groupRef: group.group
            }
        );

        await senderSocket.dispatchMessage(message);

        const sentTypes = [...senderSocket.sent, ...peerSocket.sent].map((sent) => sent.payload.typeId);

        expect(sentTypes).not.toContain(AppTopics.overlayTopology);
        expect(outsideSocket.sent).toEqual([]);
        expect(topologyService.readMetrics()).toMatchObject({
            topologyPublishAttemptCount: 0,
            topologyPublishedCount: 0,
            topologyPublishSkippedUnchangedCount: 0
        });
        expect(updateGroupTopology).not.toHaveBeenCalled();
    });

    it('queues immutable app-outbox work with canonical identity without scheduling from inbound snapshots', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const server = new JsonWebSocketServer();
        const sockets = createSockets([
            'session-a',
            'session-b',
            'session-c',
            'session-d',
            'session-e'
        ]);

        for (const [sessionId, socket] of sockets) {
            server.addConnection(new ConnectionContext(sessionId, socket as never));
        }

        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        const topologyService = new RallarRtcTopologyService();
        const appOutbox = new InMemoryQueueBox(new Map());
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const topologyOutbox = createRtcTopologyOutboxPublisher({
            outboxQueueReader
        });
        initRallarSystemWsTopics(service, {
            rtcTopologyService: topologyService,
            ...topologyOptions(createTopologyOwners(topologyService)),
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(runtimeRepository),
                findGroupSnapshotByRef: (ref) => Promise.resolve(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref))
            }
        });

        const group = createGroupSnapshot('room-1', [...sockets.keys()]);
        clientStateSnapshotsRepository.setClientStateSnapshots(
            [...sockets.keys()].map(createClientSnapshot)
        );
        const senderSocket = sockets.get('session-a')!;

        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-active'),
                'room',
                AppTopics.groupStateSnapshot,
                group,
                {
                    groupRef: group.group
                }
            )
        );

        expect(await appOutbox.getAllKeys()).toEqual([]);
        expect(countSentTopologyMessages(sockets)).toBe(0);
        await topologyOutbox.publisher.enqueueForGroupSnapshot(group);
        await topologyOutbox.publisher.enqueueForGroupSnapshot(group);
        const [activeKey] = await appOutbox.getAllKeys();
        expect(activeKey).toMatchObject({
            topicId: 'app-outbox.rtc-topology',
            resourceId: expect.any(String)
        });
        const activeEntry = await appOutbox.getItem(activeKey!);
        const activeMessage = JSON.parse(activeEntry!.resource) as ALMessage;
        const activeEnvelope = JSON.parse(activeMessage.payload.resource) as {
            resourceId: string;
            contextId: string;
            senderId: string;
            data: {
                groupSnapshot: GroupSnapshot;
                requestOptions: object;
                publish: boolean;
            };
        };
        expect(activeMessage.route).toEqual(activeKey);
        expect(activeEnvelope).toMatchObject({
            resourceId: expect.stringContaining(
                `:group-revision:group=${group.causalRevision.groupRevision};presence=${group.causalRevision.presenceRevision}`
            ),
            contextId: expect.stringContaining('group=room-1'),
            senderId: expect.any(String),
            data: {
                groupSnapshot: group,
                requestOptions: {},
                publish: true
            }
        });
        expect(await appOutbox.getAllKeys()).toHaveLength(1);
        expect(countSentTopologyMessages(sockets)).toBe(0);

        const archivedGroup = createInactiveGroupSnapshot(group, 'archived');
        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    archivedGroup.group.groupId,
                    'group-snapshot-archived'
                ),
                'room',
                AppTopics.groupStateSnapshot,
                archivedGroup,
                {
                    groupRef: archivedGroup.group
                }
            )
        );

        expect(await appOutbox.getAllKeys()).toHaveLength(1);
        await topologyOutbox.publisher.enqueueForGroupSnapshot(archivedGroup);
        expect(await appOutbox.getAllKeys()).toHaveLength(2);
        expect(countSentTopologyMessages(sockets)).toBe(0);
    });

    it('does not create topology work from an inbound group snapshot when app outbox owns topology', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-a', senderSocket as never));

        const appOutbox = new InMemoryQueueBox(new Map());
        const runtimeRepository = new FakeRuntimeStateRepository();
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1'
        );
        initRallarSystemWsTopics(service, {
            ...topologyOptions(createTopologyOwners()),
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(runtimeRepository)
            }
        });
        const group = createGroupSnapshot('room-1', ['session-a']);

        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, 'group-snapshot-1'),
                'room',
                AppTopics.groupStateSnapshot,
                group,
                { groupRef: group.group }
            )
        );

        const resilience = createResilience();
        expect(
            await appOutbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience.checkReserveTimeouts.isEntryRateLimiter,
                resilience.checkFairness.isEntryRateLimiter
            )
        ).toBe(false);
    });

    it('does not create topology work while draining a local WS_OUTBOX snapshot', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const peerSocket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-a', senderSocket as never));
        server.addConnection(new ConnectionContext('session-b', peerSocket as never));

        const wsOutbox = new InMemoryQueueBox(new Map());
        const appOutbox = new InMemoryQueueBox(new Map());
        const runtimeRepository = new FakeRuntimeStateRepository();
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            wsOutbox,
            server,
            'server-1'
        );
        initRallarSystemWsTopics(service, {
            ...topologyOptions(createTopologyOwners()),
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(runtimeRepository)
            }
        });
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateSnapshot, group.group.groupId, group.group.groupId),
            'all',
            AppTopics.groupStateSnapshot,
            group,
            { groupRef: group.group }
        );

        await service.enqueueOutboxIfAbsent(message);
        await service.dequeueOutbox(WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES, createResilience());

        const resilience = createResilience();
        expect(
            await appOutbox.isAnyEntryToLock(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                resilience.checkReserveTimeouts.isEntryRateLimiter,
                resilience.checkFairness.isEntryRateLimiter
            )
        ).toBe(false);
        expect(countSentTopologyMessages(createSocketsFrom([senderSocket, peerSocket]))).toBe(0);
    });

    it('converges multiple app-outbox publishers on one immutable work identity', async () => {
        configureTestCacheRepositories();
        const appOutboxQueue = new InMemoryQueueBox(new Map());
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        const deliveryId = [
            'group-command-1',
            'rtc-topology-recompute',
            'group-revision',
            `group=${group.causalRevision.groupRevision};presence=${group.causalRevision.presenceRevision}`
        ].join(':');
        const publisherA = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(appOutboxQueue),
            senderId: 'worker-a',
            now: () => 1_000
        }).publisher;
        const publisherB = createRtcTopologyOutboxPublisher({
            outboxQueueReader: new OutboxQueueReader(appOutboxQueue),
            senderId: 'worker-b',
            now: () => 1_001
        }).publisher;

        const [first, second] = await Promise.all([
            publisherA.enqueueForStateMutation(group, deliveryId),
            publisherB.enqueueForStateMutation(group, deliveryId)
        ]);

        expect(first).toEqual(second);
        expect(first.effectiveCausalRevision).toEqual(group.causalRevision);
        const [key] = await appOutboxQueue.getAllKeys();
        expect(key?.resourceId).toEqual(expect.any(String));
        expect(await appOutboxQueue.getAllKeys()).toHaveLength(1);
        const entry = await appOutboxQueue.getItem(key!);
        const message = JSON.parse(entry!.resource) as ALMessage;
        const envelope = JSON.parse(message.payload.resource) as {
            resourceId: string;
            senderId: string;
            data: {
                groupSnapshot: GroupSnapshot;
                requestOptions: object;
                publish: boolean;
            };
        };
        expect(message.route).toEqual(key);
        expect(envelope).toMatchObject({
            resourceId: deliveryId,
            senderId: expect.stringMatching(/^worker-/),
            data: {
                groupSnapshot: group,
                requestOptions: {},
                publish: true
            }
        });
    });
});

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    readonly sent: ALMessage[] = [];
    private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

    addEventListener(type: string, listener: (event: MessageEvent) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    send(data: string): void {
        this.sent.push(JSON.parse(data) as ALMessage);
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = {
            data: JSON.stringify(message)
        } as MessageEvent;

        for (const listener of this.listeners.get('message') ?? []) {
            await listener(event);
        }
    }
}
function createSockets(sessionIds: readonly string[]): Map<string, FakeSocket> {
    return new Map(sessionIds.map((sessionId) => [sessionId, new FakeSocket()]));
}

function createSocketsFrom(sockets: readonly FakeSocket[]): Map<string, FakeSocket> {
    return new Map(sockets.map((socket, index) => [`socket-${index}`, socket]));
}

function countSentTopologyMessages(sockets: ReadonlyMap<string, FakeSocket>): number {
    return [...sockets.values()]
        .flatMap((socket) => socket.sent)
        .filter((sent) => sent.payload.typeId === AppTopics.overlayTopology).length;
}

function createTopologyExecutionDependencies(runtimeRepository: FakeRuntimeStateRepository) {
    return {
        database: createUnusedDatabase(),
        executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
    };
}

function createTopologyOwners(
    topologyService = new RallarRtcTopologyService(),
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader = () => undefined
): GroupTopologyOwners {
    return createGroupTopologyOwners({
        findGroupSnapshotByRef,
        topologyService
    });
}

function topologyOptions(owners: GroupTopologyOwners) {
    return {
        topologyQuery: owners.query,
        topologyPlanning: owners.planning
    };
}

function createUnusedDatabase(): PSqlSql {
    return Object.assign(
        () => Promise.reject(new Error('Unexpected SQL execution in WS routing unit test')),
        {
            begin: () => Promise.reject(new Error('Unexpected transaction in WS routing unit test'))
        }
    );
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1
    );
}

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'owner' },
        reason: null,
        traceId: null,
        requestId: null
    };
}

function createClientSnapshot(sessionId: string): ClientSnapshot {
    return {
        stateRevision: 1,
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: sessionId,
            username: sessionId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            created: audit(1),
            updated: audit(1),
            lastSeenAtEpochMs: 1,
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1
        },
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: sessionId,
                sessionId,
                clientInstanceId: `${sessionId}-instance`,
                generationId: `${sessionId}-generation`,
                generationVersion: 1,
                status: 'active',
                transport: 'ws',
                presenceState: 'online',
                connectionId: null,
                connectedAtEpochMs: 1,
                authenticatedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: Date.now() + 60_000,
                disconnectedAtEpochMs: null,
                disconnectReason: null
            }
        ],
        instances: [],
        activeSessionCount: 1,
        isOnline: true,
        lastSeenAtEpochMs: 1
    };
}

function createGroupSnapshot(groupId: string, memberSessionIds: readonly string[]): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        causalRevision: {
            groupRevision: 1,
            presenceRevision: 0
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId: memberSessionIds[0]!,
            created: audit(1),
            updated: audit(1)
        }),
        members: memberSessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(1)
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: Date.now() + 60_000,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
    };
}

function createInactiveGroupSnapshot(
    snapshot: GroupSnapshot,
    status: 'archived' | 'deleted'
): GroupSnapshot {
    const lifecycleAudit = audit(2);

    return {
        ...snapshot,
        causalRevision: {
            ...snapshot.causalRevision,
            groupRevision: snapshot.causalRevision.groupRevision + 1
        },
        group: status === 'archived'
            ? {
                ...snapshot.group,
                status: 'archived',
                snapshotVersion: snapshot.group.snapshotVersion + 1,
                updated: lifecycleAudit,
                archived: lifecycleAudit,
                deleted: null
            }
            : {
                ...snapshot.group,
                status: 'deleted',
                snapshotVersion: snapshot.group.snapshotVersion + 1,
                updated: lifecycleAudit,
                archived: snapshot.group.archived,
                deleted: lifecycleAudit
            },
        activeSessions: [],
        onlineMemberCount: 0
    };
}
