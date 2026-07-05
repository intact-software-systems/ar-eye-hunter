import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';
import {
    AppTopics,
    CircuitBreakerPolicy,
    ConnectionContext,
    InMemoryQueueBox,
    JsonWebSocketServer,
    ResilienceDto,
    newALBroadcastMessage,
    newALEventRoute,
    WsQueueBoxServerService,
    type ALMessage,
} from '@shared/mod.ts';
import { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { latestRttById } from '@shared/repository/rtt-repository.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('Rallar system websocket topics RTC topology', () => {
    it('broadcasts overlay topology after accepted group snapshots', async () => {
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
            'server-1',
        );
        const topologyService = new RallarRtcTopologyService();
        initRallarSystemWsTopics(service, {
            rtcTopologyService: topologyService,
        });

        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('session-a'),
            createClientSnapshot('session-b'),
            createClientSnapshot('session-c'),
        ]);
        const message = newALBroadcastMessage(
            'session-a',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                group.group.groupId,
                'group-snapshot-1',
            ),
            'room',
            AppTopics.groupStateSnapshot,
            group,
            {
                groupRef: group.group,
            },
        );

        await senderSocket.dispatchMessage(message);

        const sentTypes = [...senderSocket.sent, ...peerSocket.sent]
            .map((sent) => sent.payload.typeId);

        expect(sentTypes).toContain(AppTopics.overlayTopology);
        expect(outsideSocket.sent).toEqual([]);

        const topology = peerSocket.sent
            .find((sent) => sent.payload.typeId === AppTopics.overlayTopology);
        expect(topology?.targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: group.group.applicationId,
                workspaceId: group.group.workspaceId,
                groupId: group.group.groupId,
            },
        });
        expect(topologyService.readMetrics()).toMatchObject({
            topologyPublishAttemptCount: 1,
            topologyPublishedCount: 1,
            topologyPublishSkippedUnchangedCount: 0,
        });

        const unchangedGroup = {
            ...group,
            group: {
                ...group.group,
                snapshotVersion: 2,
            },
        };
        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    unchangedGroup.group.groupId,
                    'group-snapshot-2',
                ),
                'room',
                AppTopics.groupStateSnapshot,
                unchangedGroup,
                {
                    groupRef: unchangedGroup.group,
                },
            ),
        );

        expect(topologyService.readMetrics()).toMatchObject({
            topologyPublishAttemptCount: 2,
            topologyPublishedCount: 1,
            topologyPublishSkippedUnchangedCount: 1,
        });
    });

    it('removes cached topology when a group snapshot becomes inactive', async () => {
        configureTestCacheRepositories();

        const runtimeRepository = new FakeRuntimeStateRepository();
        const topologyRepository = new RtcTopologySnapshotRepository(
            runtimeRepository,
        );
        const server = new JsonWebSocketServer();
        const sockets = createSockets([
            'session-a',
            'session-b',
            'session-c',
            'session-d',
            'session-e',
        ]);

        for (const [sessionId, socket] of sockets) {
            server.addConnection(
                new ConnectionContext(sessionId, socket as never),
            );
        }

        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1',
        );
        const topologyService = new RallarRtcTopologyService();
        initRallarSystemWsTopics(service, {
            rtcTopologyService: topologyService,
            rtcTopologyRuntimeState: {
                repository: runtimeRepository,
            },
        });

        const group = createGroupSnapshot('room-1', [...sockets.keys()]);
        clientStateSnapshotsRepository.setClientStateSnapshots(
            [...sockets.keys()].map(createClientSnapshot),
        );
        const senderSocket = sockets.get('session-a')!;

        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    group.group.groupId,
                    'group-snapshot-active',
                ),
                'room',
                AppTopics.groupStateSnapshot,
                group,
                {
                    groupRef: group.group,
                },
            ),
        );

        expect(countSentTopologyMessages(sockets)).toBe(5);
        expect(topologyService.readSnapshot(group)).toBeDefined();
        expect(await topologyRepository.findSnapshot(group.group)).toBeDefined();
        expect(topologyService.readMetrics()).toMatchObject({
            topologySnapshotCount: 1,
            topologyRemovalRequestCount: 0,
        });

        for (const socket of sockets.values()) {
            socket.sent.length = 0;
        }

        const archivedGroup = createInactiveGroupSnapshot(group, 'archived');
        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    archivedGroup.group.groupId,
                    'group-snapshot-archived',
                ),
                'room',
                AppTopics.groupStateSnapshot,
                archivedGroup,
                {
                    groupRef: archivedGroup.group,
                },
            ),
        );

        expect(countSentTopologyMessages(sockets)).toBe(0);
        expect(topologyService.readSnapshot(group)).toBeUndefined();
        expect(await topologyRepository.findSnapshot(group.group)).toBeUndefined();
        expect(topologyService.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 1,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 0,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0,
        });
    });

    it('debounces and coalesces RTT-triggered overlay topology broadcasts', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            configureTestCacheRepositories();

            const server = new JsonWebSocketServer();
            const sockets = createSockets([
                'session-a',
                'session-b',
                'session-c',
                'session-d',
                'session-e',
            ]);

            for (const [sessionId, socket] of sockets) {
                server.addConnection(
                    new ConnectionContext(sessionId, socket as never),
                );
            }

            const service = new WsQueueBoxServerService(
                new InMemoryQueueBox(new Map()),
                new InMemoryQueueBox(new Map()),
                server,
                'server-1',
            );
            initRallarSystemWsTopics(service, {
                rtcTopologyOptions: {
                    rttRebuildDebounceMs: 100,
                },
            });

            const group = createGroupSnapshot('room-1', [...sockets.keys()]);
            clientStateSnapshotsRepository.setClientStateSnapshots(
                [...sockets.keys()].map(createClientSnapshot),
            );
            const senderSocket = sockets.get('session-a')!;

            await senderSocket.dispatchMessage(
                newALBroadcastMessage(
                    'session-a',
                    newALEventRoute(
                        AppTopics.groupStateSnapshot,
                        group.group.groupId,
                        'group-snapshot-1',
                    ),
                    'room',
                    AppTopics.groupStateSnapshot,
                    group,
                    {
                        groupRef: group.group,
                    },
                ),
            );

            for (const socket of sockets.values()) {
                socket.sent.length = 0;
            }

            const fullSnapshotScan = vi.spyOn(
                groupStateSnapshotsRepository,
                'getAllGroupStateSnapshots',
            );

            for (const rtt of createCentralRttMeasurements(
                [...sockets.keys()],
                'session-a',
            )) {
                await senderSocket.dispatchMessage(
                    newALBroadcastMessage(
                        'session-a',
                        newALEventRoute(
                            AppTopics.rtt,
                            group.group.groupId,
                            `rtt-${rtt.version}`,
                        ),
                        'room',
                        AppTopics.rtt,
                        rtt,
                        {
                            groupRef: group.group,
                        },
                    ),
                );
            }

            expect(fullSnapshotScan).not.toHaveBeenCalled();
            fullSnapshotScan.mockRestore();
            expect(countSentTopologyMessages(sockets)).toBe(0);

            await vi.advanceTimersByTimeAsync(99);
            expect(countSentTopologyMessages(sockets)).toBe(0);

            await vi.advanceTimersByTimeAsync(1);
            expect(countSentTopologyMessages(sockets)).toBe(5);

            const topology = senderSocket.sent.find((sent) =>
                sent.payload.typeId === AppTopics.overlayTopology
            );
            const snapshot = topology
                ? JSON.parse(topology.payload.resource) as {
                version?: number;
                nextHopsBySessionId?: Record<string, readonly string[]>;
            }
                : undefined;

            expect(snapshot?.version).toBe(2);
            expect(snapshot?.nextHopsBySessionId?.['session-a']).toHaveLength(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('can route group-triggered topology recomputes through app inbox ownership', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const peerSocket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-a', senderSocket as never));
        server.addConnection(new ConnectionContext('session-b', peerSocket as never));

        const appInboxQueue = new InMemoryQueueBox(new Map());
        const inboxQueueReader = new InboxQueueReader(appInboxQueue);
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        const findGroupSnapshotByRef = vi.fn(async () => group);
        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1',
        );
        initRallarSystemWsTopics(service, {
            rtcTopologyAppInbox: {
                inboxQueueReader,
                findGroupSnapshotByRef,
            },
        });
        clientStateSnapshotsRepository.setClientStateSnapshots([
            createClientSnapshot('session-a'),
            createClientSnapshot('session-b'),
        ]);

        await senderSocket.dispatchMessage(
            newALBroadcastMessage(
                'session-a',
                newALEventRoute(
                    AppTopics.groupStateSnapshot,
                    group.group.groupId,
                    'group-snapshot-1',
                ),
                'room',
                AppTopics.groupStateSnapshot,
                group,
                {
                    groupRef: group.group,
                },
            ),
        );

        expect(countSentTopologyMessages(createSocketsFrom([
            senderSocket,
            peerSocket,
        ]))).toBe(0);

        await inboxQueueReader.dequeueInbox(
            InboxQueueReader.INBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(findGroupSnapshotByRef).toHaveBeenCalledWith(group.group, {
            minSnapshotVersion: 1,
        });
        expect(countSentTopologyMessages(createSocketsFrom([
            senderSocket,
            peerSocket,
        ]))).toBe(2);
    });

    it('can route RTT-triggered topology recomputes through app inbox ownership', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            configureTestCacheRepositories();

            const server = new JsonWebSocketServer();
            const sockets = createSockets([
                'session-a',
                'session-b',
                'session-c',
                'session-d',
                'session-e',
            ]);

            for (const [sessionId, socket] of sockets) {
                server.addConnection(
                    new ConnectionContext(sessionId, socket as never),
                );
            }

            const appInboxQueue = new InMemoryQueueBox(new Map());
            const inboxQueueReader = new InboxQueueReader(appInboxQueue);
            const wake = vi.fn();
            const service = new WsQueueBoxServerService(
                new InMemoryQueueBox(new Map()),
                new InMemoryQueueBox(new Map()),
                server,
                'server-1',
            );
            initRallarSystemWsTopics(service, {
                rtcTopologyOptions: {
                    rttRebuildDebounceMs: 100,
                },
                rtcTopologyAppInbox: {
                    inboxQueueReader,
                    wake,
                },
            });

            const group = createGroupSnapshot('room-1', [...sockets.keys()]);
            clientStateSnapshotsRepository.setClientStateSnapshots(
                [...sockets.keys()].map(createClientSnapshot),
            );
            const senderSocket = sockets.get('session-a')!;

            await senderSocket.dispatchMessage(
                newALBroadcastMessage(
                    'session-a',
                    newALEventRoute(
                        AppTopics.groupStateSnapshot,
                        group.group.groupId,
                        'group-snapshot-1',
                    ),
                    'room',
                    AppTopics.groupStateSnapshot,
                    group,
                    {
                        groupRef: group.group,
                    },
                ),
            );

            await inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );
            expect(countSentTopologyMessages(sockets)).toBe(5);

            for (const socket of sockets.values()) {
                socket.sent.length = 0;
            }

            const fullSnapshotScan = vi.spyOn(
                groupStateSnapshotsRepository,
                'getAllGroupStateSnapshots',
            );

            for (const rtt of createCentralRttMeasurements(
                [...sockets.keys()],
                'session-a',
            )) {
                await senderSocket.dispatchMessage(
                    newALBroadcastMessage(
                        'session-a',
                        newALEventRoute(
                            AppTopics.rtt,
                            group.group.groupId,
                            `rtt-${rtt.version}`,
                        ),
                        'room',
                        AppTopics.rtt,
                        rtt,
                        {
                            groupRef: group.group,
                        },
                    ),
                );
            }

            expect(fullSnapshotScan).not.toHaveBeenCalled();
            fullSnapshotScan.mockRestore();
            expect(wake).toHaveBeenCalled();
            expect(countSentTopologyMessages(sockets)).toBe(0);

            await inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );
            expect(countSentTopologyMessages(sockets)).toBe(0);

            vi.setSystemTime(1_100);
            await inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );

            expect(countSentTopologyMessages(sockets)).toBe(5);
            const topology = senderSocket.sent.find((sent) =>
                sent.payload.typeId === AppTopics.overlayTopology
            );
            const snapshot = topology
                ? JSON.parse(topology.payload.resource) as {
                    version?: number;
                    nextHopsBySessionId?: Record<string, readonly string[]>;
                }
                : undefined;

            expect(snapshot?.version).toBe(2);
            expect(snapshot?.nextHopsBySessionId?.['session-a']).toHaveLength(4);
        } finally {
            vi.useRealTimers();
        }
    });

    it('uses durable topology snapshots and RTTs across app-inbox workers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            configureTestCacheRepositories();

            const runtimeRepository = new FakeRuntimeStateRepository();
            const appInboxQueue = new InMemoryQueueBox(new Map());
            const group = createGroupSnapshot('room-1', [
                'session-a',
                'session-b',
                'session-c',
                'session-d',
                'session-e',
            ]);
            clientStateSnapshotsRepository.setClientStateSnapshots(
                group.activeSessions.map((session) =>
                    createClientSnapshot(session.sessionId)
                ),
            );

            const workerA = createTopologyWorker(
                appInboxQueue,
                runtimeRepository,
                group,
                'worker-a',
            );

            await workerA.senderSocket.dispatchMessage(
                newALBroadcastMessage(
                    'session-a',
                    newALEventRoute(
                        AppTopics.groupStateSnapshot,
                        group.group.groupId,
                        'group-snapshot-1',
                    ),
                    'room',
                    AppTopics.groupStateSnapshot,
                    group,
                    {
                        groupRef: group.group,
                    },
                ),
            );

            await workerA.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );

            const firstTopology = findSentTopology(workerA.sockets);
            expect(firstTopology?.version).toBe(1);

            const workerB = createTopologyWorker(
                appInboxQueue,
                runtimeRepository,
                group,
                'worker-b',
            );

            for (const rtt of createCentralRttMeasurements(
                group.activeSessions.map((session) => session.sessionId),
                'session-a',
            )) {
                await workerB.senderSocket.dispatchMessage(
                    newALBroadcastMessage(
                        'session-a',
                        newALEventRoute(
                            AppTopics.rtt,
                            group.group.groupId,
                            `rtt-${rtt.version}`,
                        ),
                        'room',
                        AppTopics.rtt,
                        rtt,
                        {
                            groupRef: group.group,
                        },
                    ),
                );
            }

            latestRttById().clearAll();

            const workerC = createTopologyWorker(
                appInboxQueue,
                runtimeRepository,
                group,
                'worker-c',
            );

            vi.setSystemTime(1_100);
            await workerC.inboxQueueReader.dequeueInbox(
                InboxQueueReader.INBOX_DEQUEUE_TYPES,
                createResilience(),
            );

            const secondTopology = findSentTopology(workerC.sockets);
            expect(secondTopology?.version).toBe(2);
            expect(secondTopology?.nextHopsBySessionId?.['session-a'])
                .toHaveLength(4);
        } finally {
            vi.useRealTimers();
        }
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
            data: JSON.stringify(message),
        } as MessageEvent;

        for (const listener of this.listeners.get('message') ?? []) {
            await listener(event);
        }
    }
}

function createSockets(
    sessionIds: readonly string[],
): Map<string, FakeSocket> {
    return new Map(sessionIds.map((sessionId) => [sessionId, new FakeSocket()]));
}

function createSocketsFrom(
    sockets: readonly FakeSocket[],
): Map<string, FakeSocket> {
    return new Map(sockets.map((socket, index) => [`socket-${index}`, socket]));
}

function countSentTopologyMessages(
    sockets: ReadonlyMap<string, FakeSocket>,
): number {
    return [...sockets.values()]
        .flatMap((socket) => socket.sent)
        .filter((sent) => sent.payload.typeId === AppTopics.overlayTopology)
        .length;
}

function findSentTopology(
    sockets: ReadonlyMap<string, FakeSocket>,
): {
    readonly version?: number;
    readonly nextHopsBySessionId?: Record<string, readonly string[]>;
} | undefined {
    const message = [...sockets.values()]
        .flatMap((socket) => socket.sent)
        .find((sent) => sent.payload.typeId === AppTopics.overlayTopology);

    return message
        ? JSON.parse(message.payload.resource) as {
            version?: number;
            nextHopsBySessionId?: Record<string, readonly string[]>;
        }
        : undefined;
}

function createTopologyWorker(
    appInboxQueue: InMemoryQueueBox,
    runtimeRepository: FakeRuntimeStateRepository,
    group: GroupSnapshot,
    name: string,
): {
    readonly sockets: Map<string, FakeSocket>;
    readonly senderSocket: FakeSocket;
    readonly inboxQueueReader: InboxQueueReader;
} {
    const server = new JsonWebSocketServer();
    const sockets = createSockets(
        group.activeSessions.map((session) => session.sessionId),
    );

    for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
    }

    const inboxQueueReader = new InboxQueueReader(appInboxQueue);
    const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        server,
        name,
    );
    initRallarSystemWsTopics(service, {
        rtcTopologyOptions: {
            rttRebuildDebounceMs: 100,
        },
        rtcTopologyRuntimeState: {
            repository: runtimeRepository,
        },
        rtcTopologyAppInbox: {
            inboxQueueReader,
            findGroupSnapshotByRef: async () => group,
        },
    });

    return {
        sockets,
        senderSocket: sockets.get('session-a')!,
        inboxQueueReader,
    };
}

function createCentralRttMeasurements(
    sessionIds: readonly string[],
    centralSessionId: string,
): readonly {
    readonly sessionIdFrom: string;
    readonly sessionIdTo: string;
    readonly rttMs: number;
    readonly createdAtEpochMs: number;
    readonly version: number;
}[] {
    const measurements = [];
    let version = 1;

    for (let i = 0; i < sessionIds.length; i++) {
        for (let j = i + 1; j < sessionIds.length; j++) {
            const from = sessionIds[i];
            const to = sessionIds[j];
            measurements.push({
                sessionIdFrom: from,
                sessionIdTo: to,
                rttMs: from === centralSessionId || to === centralSessionId
                    ? 1
                    : 100,
                createdAtEpochMs: version,
                version: version++,
            });
        }
    }

    return measurements;
}

function createResilience(): ResilienceDto {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResilienceDto.toResilienceDto(
        new CircuitBreakerPolicy(10, duration, duration, duration),
        1,
        10,
        1,
        1,
    );
}

function createClientSnapshot(sessionId: string): ClientSnapshot {
    return {
        principal: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: sessionId,
            username: sessionId,
            status: 'active',
            roles: [],
            metadata: {},
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: 1,
            },
            profileVersion: 1,
            presenceVersion: 1,
            snapshotVersion: 1,
        },
        activeSessions: [
            {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                principalId: sessionId,
                sessionId,
                clientInstanceId: `${sessionId}-instance`,
                status: 'active',
                transport: 'ws',
                presenceState: 'online',
                connectedAtEpochMs: 1,
                authenticatedAtEpochMs: 1,
                lastHeartbeatAtEpochMs: 1,
                expiresAtEpochMs: Date.now() + 60_000,
            },
        ],
        instances: [],
        activeSessionCount: 1,
        isOnline: true,
        lastSeenAtEpochMs: 1,
    };
}

function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            snapshotVersion: 1,
            metadataVersion: 0,
            rosterVersion: 1,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: Date.now() + 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function createInactiveGroupSnapshot(
    snapshot: GroupSnapshot,
    status: 'archived' | 'deleted',
): GroupSnapshot {
    const audit = {
        atEpochMs: 2,
        byPrincipalId: 'owner',
    };

    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            status,
            snapshotVersion: snapshot.group.snapshotVersion + 1,
            updated: audit,
            archived: status === 'archived' ? audit : snapshot.group.archived,
            deleted: status === 'deleted' ? audit : snapshot.group.deleted,
        },
        activeSessions: [],
        onlineMemberCount: 0,
    };
}
