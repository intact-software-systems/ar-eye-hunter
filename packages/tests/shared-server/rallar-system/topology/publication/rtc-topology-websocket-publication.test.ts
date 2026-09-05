import { Temporal } from '@js-temporal/polyfill';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AppOutboxType } from '@shared-server/rallar-system/app-outbox/app-outbox-type.ts';
import { GroupConnectTriggerLatchRepository } from '@shared-server/rallar-system/group-state/persistence/group-connect-trigger-latch-repository.ts';
import { computeRtcTopologyOutboxInsert } from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/topology/persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyGroupSnapshotReader } from '@shared-server/rallar-system/topology/planning/group-topology-planning-contracts.ts';
import { RtcTopologyReplayEntryHandlerService } from '@shared-server/rallar-system/topology/replay/consumer/rtc-topology-replay-entry-handler.ts';
import { readRtcTopologyWorkEnvelope } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-work-codec.ts';
import {
    createGroupTopologyRuntimeOwners,
    type GroupTopologyRuntimeOwners
} from '@shared-server/rallar-system/topology/runtime/create-group-topology-runtime-owners.ts';
import { installTopologyAppOutbox, type InstallTopologyAppOutboxOptions } from '@shared-server/rallar-system/topology/runtime/install-topology-app-outbox.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/topology/runtime/rallar-rtc-topology-service.ts';
import { createWsServerTargetResolver } from '@shared-server/rallar-system/websocket/targets/create-ws-server-target-resolver.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    AppTopics,
    CircuitBreakerPolicy,
    ConnectionContext,
    createDefaultWsQueueBoxServerService,
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
import { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../../../create-test-group.ts';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { createRtcTopologyReplayFixture } from '../replay/consumer/rtc-topology-replay-fixture.ts';

describe('RTC topology websocket publication', () => {
    it('replays a durable topology publication only to its recorded sessions', async () => {
        const fixture = createRtcTopologyReplayFixture();
        const server = new JsonWebSocketServer();
        const recordedSocket = new FakeSocket();
        const outsideSocket = new FakeSocket();
        server.addConnection(new ConnectionContext({ id: 'session-1', socket: recordedSocket }));
        server.addConnection(new ConnectionContext({ id: 'session-2', socket: outsideSocket }));
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1',
            targetResolver: createWsServerTargetResolver(server)
        });
        const replay = new RtcTopologyReplayEntryHandlerService({
            publications: {
                findPublication: async () => fixture.publication
            },
            outbox: {
                getItem: async (key) => fixture.outbox.find((page) => JSON.stringify(page.key) === JSON.stringify(key))
            },
            snapshots: {
                findSnapshot: async () => fixture.currentSnapshot
            },
            acceptedSnapshots: {
                findSnapshot: async () => undefined
            },
            sender: service
        });

        await expect(
            replay.handle(
                fixture.entry,
                fixture.databaseNowEpochMs,
                new AbortController().signal
            )
        ).resolves.toEqual({ status: 'delivered' });
        expect(recordedSocket.sent).toEqual(fixture.outbox.map((page) => decodePersistedALMessage(page.resource)));
        expect(outsideSocket.sent).toEqual([]);
    });

    it('does not run a process-local topology fallback for inbound group snapshots', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const peerSocket = new FakeSocket();
        const outsideSocket = new FakeSocket();

        server.addConnection(new ConnectionContext({ id: 'session-a', socket: senderSocket }));
        server.addConnection(new ConnectionContext({ id: 'session-b', socket: peerSocket }));
        server.addConnection(new ConnectionContext({ id: 'session-c', socket: outsideSocket }));

        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
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
            server.addConnection(new ConnectionContext({ id: sessionId, socket }));
        }

        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        });
        const topologyService = new RallarRtcTopologyService();
        const appOutbox = new InMemoryQueueBox(new Map());
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        installTestTopologyOutbox(service, {
            topologyPlanning: createTopologyOwners(topologyService).planning,
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
        await enqueueTopologyGroupRevision(outboxQueueReader, group, 'active-work');
        await enqueueTopologyGroupRevision(outboxQueueReader, group, 'active-work');
        const [activeKey] = await appOutbox.getAllKeys();
        expect(activeKey).toMatchObject({
            topicId: 'app-outbox.rtc-topology',
            resourceId: expect.any(String)
        });
        const activeEntry = await appOutbox.getItem(activeKey!);
        const activeMessage = decodePersistedALMessage(activeEntry!.resource);
        const activeEnvelope = readRtcTopologyWorkEnvelope(
            activeMessage,
            AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
        );
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
        await enqueueTopologyGroupRevision(outboxQueueReader, archivedGroup, 'archived-work');
        expect(await appOutbox.getAllKeys()).toHaveLength(2);
        expect(countSentTopologyMessages(sockets)).toBe(0);
    });

    it('does not create topology work from an inbound group snapshot when app outbox owns topology', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        server.addConnection(new ConnectionContext({ id: 'session-a', socket: senderSocket }));

        const appOutbox = new InMemoryQueueBox(new Map());
        const runtimeRepository = new FakeRuntimeStateRepository();
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: new InMemoryQueueBox(new Map()),
            socket: server,
            name: 'server-1'
        });
        installTestTopologyOutbox(service, {
            topologyPlanning: createTopologyOwners().planning,
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
                resilience.toWorkAdvertisementOptions()
            )
        ).toBe(false);
    });

    it('does not create topology work while draining a local WS_OUTBOX snapshot', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const peerSocket = new FakeSocket();
        server.addConnection(new ConnectionContext({ id: 'session-a', socket: senderSocket }));
        server.addConnection(new ConnectionContext({ id: 'session-b', socket: peerSocket }));

        const wsOutbox = new InMemoryQueueBox(new Map());
        const appOutbox = new InMemoryQueueBox(new Map());
        const runtimeRepository = new FakeRuntimeStateRepository();
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const service = createDefaultWsQueueBoxServerService({
            inbox: new InMemoryQueueBox(new Map()),
            outbox: wsOutbox,
            socket: server,
            name: 'server-1'
        });
        installTestTopologyOutbox(service, {
            topologyPlanning: createTopologyOwners().planning,
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
                resilience.toWorkAdvertisementOptions()
            )
        ).toBe(false);
        expect(countSentTopologyMessages(createSocketsFrom([senderSocket, peerSocket]))).toBe(0);
    });
});

async function enqueueTopologyGroupRevision(
    outboxQueueReader: OutboxQueueReader,
    group: GroupSnapshot,
    commandId: string
): Promise<void> {
    await outboxQueueReader.outbox.enqueueIfAbsent(
        computeRtcTopologyOutboxInsert({
            commandId,
            aggregateRef: group.group,
            acceptedCausalRevision: group.causalRevision,
            groupSnapshot: group,
            effectKind: 'rtc-topology-recompute',
            payloadKind: 'group-revision',
            origin: 'automatic',
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 4_102_444_800_000,
            senderId: 'server-1',
            resourceId: `${commandId}:group-revision:group=${group.causalRevision.groupRevision};presence=${group.causalRevision.presenceRevision}`,
            requestOptions: toCanonicalGroupTopologyConfigPatch({}),
            publish: true
        }).entry
    );
}

class FakeSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
    readonly binaryType: BinaryType = 'blob';
    readonly bufferedAmount = 0;
    readonly extensions = '';
    readonly protocol = '';
    readonly readyState = WebSocket.OPEN;
    readonly url = 'ws://rtc-topology-publication-test';
    readonly sent: ALMessage[] = [];
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    private readonly messageListeners: EventListenerOrEventListenerObject[] = [];

    override addEventListener(
        type: string,
        callback: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions
    ): void {
        super.addEventListener(type, callback, options);
        if (type === 'message' && callback !== null) {
            this.messageListeners.push(callback);
        }
    }

    close(): void {}

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        if (typeof data !== 'string') {
            throw new TypeError('RTC topology publication tests require JSON text messages');
        }
        this.sent.push(decodePersistedALMessage(data));
    }

    async dispatchMessage(message: ALMessage): Promise<void> {
        const event = new MessageEvent('message', { data: JSON.stringify(message) });

        for (const listener of this.messageListeners) {
            if (typeof listener === 'function') {
                await listener.call(this, event);
            }
            else {
                await listener.handleEvent(event);
            }
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
        formationAutomation: {
            latches: new GroupConnectTriggerLatchRepository(runtimeRepository),
            readGroup: async () => null,
            readPlanned: async () => null,
            submitCommand: async () => {
                throw new Error('Unexpected formation automation');
            },
            nowEpochMs: () => 1000
        },
        executionRepository: new RtcTopologyExecutionRepository(runtimeRepository)
    };
}

function createTopologyOwners(
    topologyService = new RallarRtcTopologyService(),
    findGroupSnapshotByRef: GroupTopologyGroupSnapshotReader = () => undefined
): GroupTopologyRuntimeOwners {
    return createGroupTopologyRuntimeOwners({
        findGroupSnapshotByRef,
        readCurrentGroupSnapshot: async (ref, knownGroup) => knownGroup ?? await findGroupSnapshotByRef(ref),
        readRttMeasurements: () => [],
        topologyService
    });
}

interface InstallTestTopologyOutboxOptions {
    readonly topologyPlanning: GroupTopologyRuntimeOwners['planning'];
    readonly rtcTopologyAppOutbox:
        & Omit<InstallTopologyAppOutboxOptions, 'senderId' | 'findGroupSnapshotByRef' | 'readPlannedTopologySnapshot' | 'topologyPlanning' | 'nowEpochMs'>
        & Readonly<{
            findGroupSnapshotByRef?: GroupTopologyGroupSnapshotReader;
        }>;
}

function installTestTopologyOutbox(
    service: WsQueueBoxServerService,
    options: InstallTestTopologyOutboxOptions
): void {
    installTopologyAppOutbox({
        ...options.rtcTopologyAppOutbox,
        senderId: service.name,
        findGroupSnapshotByRef: options.rtcTopologyAppOutbox.findGroupSnapshotByRef ??
            ((ref) => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(ref)),
        // No formation criterion is installed here, so the deadline timer
        // that owns this reader never runs.
        readPlannedTopologySnapshot: async () => undefined,
        topologyPlanning: options.topologyPlanning,
        nowEpochMs: Date.now
    });
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
