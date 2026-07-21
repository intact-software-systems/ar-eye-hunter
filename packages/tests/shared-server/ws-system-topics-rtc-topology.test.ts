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
    newALUnicastMessage,
    WsQueueBoxServerService,
    type ALMessage,
} from '@shared/mod.ts';
import {
    QRtcSignalingChannel,
    QRtcSignalingMsgType,
    QRtcSignalingType,
} from '@shared/webrtc/QRtcSignalingContracts.ts';
import { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { latestRttById } from '@shared/repository/rtt-repository.ts';
import { initRallarSystemWsTopics } from '@shared-server/rallar-system/ws-system-topics.ts';
import { createRtcTopologyOutboxPublisher } from '@shared-server/rallar-system/services/RtcTopologyOutboxWork.ts';
import { RallarRtcTopologyService } from '@shared-server/rallar-system/services/rallar-rtc-topology-service.ts';
import { RtcRttRepository } from '@shared-server/rallar-system/repositories/RtcRttRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { RtcTopologyExecutionRepository } from '@shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    createDisabledRtcTopologyClusterTransport,
    createRtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import * as vivaldiService from '@shared-graph/vivaldi-service.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('Rallar system websocket topics RTC topology', () => {
    it('carries server receive and forward timing on RTC signaling messages', async () => {
        configureTestCacheRepositories();

        const server = new JsonWebSocketServer();
        const senderSocket = new FakeSocket();
        const targetSocket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-a', senderSocket as never));
        server.addConnection(new ConnectionContext('session-b', targetSocket as never));

        const service = new WsQueueBoxServerService(
            new InMemoryQueueBox(new Map()),
            new InMemoryQueueBox(new Map()),
            server,
            'server-1',
        );
        initRallarSystemWsTopics(service);
        const message = newALUnicastMessage(
            'session-a',
            newALEventRoute(AppTopics.rtcSignaling, 'session-b', 'rtc-signal-1'),
            'session-b',
            AppTopics.rtcSignaling,
            {
                channel: QRtcSignalingChannel.RtcSignal,
                type: QRtcSignalingMsgType.Signal,
                fromId: 'session-a',
                toId: 'session-b',
                sessionId: 'session-a',
                token: 'NOT_CREATED_YET',
                signalType: QRtcSignalingType.Offer,
                payload: {
                    description: {
                        type: 'offer',
                        sdp: 'secret-sdp',
                    },
                    candidate: null,
                },
            },
        );

        await senderSocket.dispatchMessage(message);

        const forwarded = targetSocket.sent.find(
            (candidate) => candidate.id.msgId === message.id.msgId,
        );
        expect(forwarded).toMatchObject({
            id: message.id,
            route: message.route,
            diagnostics: {
                wsRelayTiming: {
                    receivedAtEpochMs: expect.any(Number),
                    forwardedAtEpochMs: expect.any(Number),
                },
            },
        });
        expect(
            forwarded!.diagnostics!.wsRelayTiming!.receivedAtEpochMs,
        ).toBeLessThanOrEqual(
            forwarded!.diagnostics!.wsRelayTiming!.forwardedAtEpochMs,
        );
    });

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
        const updateGroupTopology = vi.spyOn(topologyService, 'updateGroupTopology');
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
        expect(updateGroupTopology).toHaveBeenCalledWith(
            group,
            expect.any(Array),
            expect.objectContaining({
                topologyOptions: {
                    topologyKind: 'auto',
                    degreeLimit: 5,
                    treeMinSize: 5,
                    meshMinSize: 16,
                    meshParamK: 2,
                },
            }),
        );

        const unchangedGroup = {
            ...group,
            stateRevision: 2,
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
            topologyPublishedCount: 2,
            topologyPublishSkippedUnchangedCount: 0,
        });
    });

    it('processes immutable app-outbox work without scheduling from inbound snapshots', async () => {
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
        const appOutbox = new InMemoryQueueBox(new Map());
        const outboxQueueReader = new OutboxQueueReader(appOutbox);
        const topologyOutbox = createRtcTopologyOutboxPublisher({
            outboxQueueReader,
        });
        initRallarSystemWsTopics(service, {
            rtcTopologyService: topologyService,
            rtcTopologyRuntimeState: {
                repository: runtimeRepository,
            },
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(
                    runtimeRepository,
                    server,
                    'server-1',
                ),
                findGroupSnapshotByRef: async (ref) =>
                    groupStateSnapshotsRepository
                        .findGroupStateSnapshotByRef(ref),
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

        expect(await appOutbox.getAllKeys()).toEqual([]);
        expect(countSentTopologyMessages(sockets)).toBe(0);
        await topologyOutbox.publisher.enqueueForGroupSnapshot(group);
        await outboxQueueReader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
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

        expect(await appOutbox.getAllKeys()).toHaveLength(1);
        await topologyOutbox.publisher.enqueueForGroupSnapshot(archivedGroup);
        await outboxQueueReader.dequeueOutbox(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        expect(countSentTopologyMessages(sockets)).toBe(5);
        expect(topologyService.readSnapshot(group)).toBeUndefined();
        expect(await topologyRepository.findSnapshot(group.group)).toMatchObject({
            state: 'removed',
            sourceGroupStateRevision: archivedGroup.stateRevision,
            updatedAtEpochMs: archivedGroup.group.updated.atEpochMs,
        });
        expect(topologyService.readMetrics()).toMatchObject({
            topologyRemovalRequestCount: 1,
            topologyRemovedCount: 1,
            topologyRemoveMissCount: 0,
            topologySnapshotCount: 0,
            pendingRttUpdateCount: 0,
        });
    });

    it('rejects RTT measurements from a mismatched AL sender', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a', 'session-b']);
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-b',
            sessionIdTo: 'session-a',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-a::session-b')).toBeUndefined();
    });

    it('rejects RTT measurements for self pairs', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a']);
        const group = createGroupSnapshot('room-1', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-a',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-a::session-a')).toBeUndefined();
    });

    it('rejects invalid RTT measurements', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a', 'session-b']);
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 0,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-a::session-b')).toBeUndefined();
    });

    it('rejects RTT measurements without a shared active group', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c']);
        const group = createGroupSnapshot('room-1', ['session-a', 'session-c']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-a::session-b')).toBeUndefined();
    });

    it('rejects RTT measurements outside the reporting edge policy', async () => {
        configureTestCacheRepositories();
        const { sockets, topologyService } = createRttHarness(
            ['session-a', 'session-b', 'session-c', 'session-d'],
            {
                rtcTopologyOptions: {
                    rttReportingDegreeLimit: 1,
                },
            },
        );
        const group = createGroupSnapshot('room-1', [
            'session-a',
            'session-b',
            'session-c',
            'session-d',
        ]);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        topologyService.updateGroupTopology(group);

        await dispatchRtt(sockets.get('session-c')!, 'session-c', {
            sessionIdFrom: 'session-c',
            sessionIdTo: 'session-d',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-c::session-d')).toBeUndefined();
    });

    it('ignores stale RTT measurements before Vivaldi or topology work', async () => {
        configureTestCacheRepositories();
        const { sockets, topologyService } = createRttHarness(
            ['session-a', 'session-b'],
            {
                rtcTopologyOptions: {
                    rttRebuildDebounceMs: 0,
                },
            },
        );
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const observeRtt = vi.spyOn(vivaldiService, 'observeRtt');
        const queueRttTopologyUpdate = vi.spyOn(
            topologyService,
            'queueRttTopologyUpdate',
        );

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 2,
            version: 2,
        }, group);

        observeRtt.mockClear();
        queueRttTopologyUpdate.mockClear();

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 4,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(latestRttById().read('session-a::session-b')?.rttMs).toBe(12);
        expect(observeRtt).not.toHaveBeenCalled();
        expect(queueRttTopologyUpdate).not.toHaveBeenCalled();
    });

    it('rejects RTT measurements that would exceed the reporting degree', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
            rtcTopologyOptions: {
                rttReportingDegreeLimit: 1,
            },
        });
        const group = createGroupSnapshot('room-1', [
            'session-a',
            'session-b',
            'session-c',
        ]);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);
        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 13,
            createdAtEpochMs: 2,
            version: 2,
        }, group);

        expect(latestRttById().read('session-a::session-b')).toBeDefined();
        expect(latestRttById().read('session-a::session-c')).toBeUndefined();
    });

    it('rejects over-degree RTT measurements across active groups', async () => {
        configureTestCacheRepositories();
        const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
            rtcTopologyOptions: {
                rttReportingDegreeLimit: 1,
            },
        });
        const groupOne = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        const groupTwo = createGroupSnapshot('room-2', ['session-a', 'session-c']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(groupOne);
        groupStateSnapshotsRepository.setGroupStateSnapshot(groupTwo);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, groupOne);
        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 13,
            createdAtEpochMs: 2,
            version: 2,
        }, groupTwo);

        expect(latestRttById().read('session-a::session-b')).toBeDefined();
        expect(latestRttById().read('session-a::session-c')).toBeUndefined();
    });

    it('rejects over-degree RTT measurements with runtime-state storage', async () => {
        configureTestCacheRepositories();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
            rtcTopologyOptions: {
                rttReportingDegreeLimit: 1,
            },
            runtimeRepository,
        });
        const group = createGroupSnapshot('room-1', [
            'session-a',
            'session-b',
            'session-c',
        ]);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);
        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 13,
            createdAtEpochMs: 2,
            version: 2,
        }, group);

        const durableRtts = new RtcRttRepository(runtimeRepository);
        expect(await durableRtts.findMeasurement('session-a', 'session-b'))
            .toBeDefined();
        expect(await durableRtts.findMeasurement('session-a', 'session-c'))
            .toBeUndefined();
    });

    it('rejects runtime-state over-degree RTT measurements across active groups', async () => {
        configureTestCacheRepositories();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const { sockets } = createRttHarness(['session-a', 'session-b', 'session-c'], {
            rtcTopologyOptions: {
                rttReportingDegreeLimit: 1,
            },
            runtimeRepository,
        });
        const groupOne = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        const groupTwo = createGroupSnapshot('room-2', ['session-a', 'session-c']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(groupOne);
        groupStateSnapshotsRepository.setGroupStateSnapshot(groupTwo);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, groupOne);
        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-c',
            rttMs: 13,
            createdAtEpochMs: 2,
            version: 2,
        }, groupTwo);

        const durableRtts = new RtcRttRepository(runtimeRepository);
        expect(await durableRtts.findMeasurement('session-a', 'session-b'))
            .toBeDefined();
        expect(await durableRtts.findMeasurement('session-a', 'session-c'))
            .toBeUndefined();
    });

    it('locks RTT endpoints before accepting runtime-state measurements', async () => {
        configureTestCacheRepositories();
        const runtimeRepository = new FakeRuntimeStateRepository();
        const { sockets } = createRttHarness(['session-a', 'session-b'], {
            runtimeRepository,
        });
        const group = createGroupSnapshot('room-1', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        await dispatchRtt(sockets.get('session-a')!, 'session-a', {
            sessionIdFrom: 'session-a',
            sessionIdTo: 'session-b',
            rttMs: 12,
            createdAtEpochMs: 1,
            version: 1,
        }, group);

        expect(runtimeRepository.locks).toEqual(
            expect.arrayContaining([
                {
                    namespace: 'rtc-rtt:latest',
                    key: 'endpoint=session-a',
                },
                {
                    namespace: 'rtc-rtt:latest',
                    key: 'endpoint=session-b',
                },
            ]),
        );
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
            'server-1',
        );
        initRallarSystemWsTopics(service, {
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(
                    runtimeRepository,
                    server,
                    'server-1',
                ),
            },
        });
        const group = createGroupSnapshot('room-1', ['session-a']);

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
                { groupRef: group.group },
            ),
        );

        const resilience = createResilience();
        expect(await appOutbox.isAnyEntryToLock(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            resilience.checkReserveTimeouts.isEntryRateLimiter,
            resilience.checkFailed.isEntryRateLimiter,
        )).toBe(false);
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
            'server-1',
        );
        initRallarSystemWsTopics(service, {
            rtcTopologyAppOutbox: {
                outboxQueueReader,
                ...createTopologyExecutionDependencies(
                    runtimeRepository,
                    server,
                    'server-1',
                ),
            },
        });
        const group = createGroupSnapshot('room-1', [
            'session-a',
            'session-b',
        ]);
        const message = newALBroadcastMessage(
            'server-1',
            newALEventRoute(
                AppTopics.groupStateSnapshot,
                group.group.groupId,
                group.group.groupId,
            ),
            'all',
            AppTopics.groupStateSnapshot,
            group,
            { groupRef: group.group },
        );

        await service.enqueueOutboxIfAbsent(message);
        await service.dequeueOutbox(
            WsQueueBoxServerService.OUTBOX_DEQUEUE_TYPES,
            createResilience(),
        );

        const resilience = createResilience();
        expect(await appOutbox.isAnyEntryToLock(
            OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
            resilience.checkReserveTimeouts.isEntryRateLimiter,
            resilience.checkFailed.isEntryRateLimiter,
        )).toBe(false);
        expect(countSentTopologyMessages(createSocketsFrom([
            senderSocket,
            peerSocket,
        ]))).toBe(0);
    });

    it('routes RTT-triggered topology recomputes through app outbox ownership', async () => {
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

            const appOutboxQueue = new InMemoryQueueBox(new Map());
            const runtimeRepository = new FakeRuntimeStateRepository();
            const outboxQueueReader = new OutboxQueueReader(appOutboxQueue);
            const wake = vi.fn();
            const service = new WsQueueBoxServerService(
                new InMemoryQueueBox(new Map()),
                new InMemoryQueueBox(new Map()),
                server,
                'server-1',
            );
            const group = createGroupSnapshot('room-1', [...sockets.keys()]);
            const findGroupSnapshotByRef = vi.fn(async () => group);
            initRallarSystemWsTopics(service, {
                rtcTopologyOptions: {
                    rttRebuildDebounceMs: 100,
                },
                rtcTopologyAppOutbox: {
                    outboxQueueReader,
                    ...createTopologyExecutionDependencies(
                        runtimeRepository,
                        server,
                        'server-1',
                    ),
                    wake,
                    findGroupSnapshotByRef,
                },
            });

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
            await createRtcTopologyOutboxPublisher({ outboxQueueReader })
                .publisher.enqueueForGroupSnapshot(group);

            await outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                createResilience(),
            );
            expect(countSentTopologyMessages(sockets)).toBe(5);

            for (const socket of sockets.values()) {
                socket.sent.length = 0;
            }
            groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(
                group.group,
            );

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
            groupStateSnapshotsRepository.setGroupStateSnapshot(group);

            expect(fullSnapshotScan).not.toHaveBeenCalled();
            fullSnapshotScan.mockRestore();
            expect(wake).toHaveBeenCalled();
            expect(findGroupSnapshotByRef).toHaveBeenCalledWith({
                applicationId: group.group.applicationId,
                workspaceId: group.group.workspaceId,
                groupId: group.group.groupId,
            });
            expect(countSentTopologyMessages(sockets)).toBe(0);

            await outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                createResilience(),
            );
            expect(countSentTopologyMessages(sockets)).toBe(0);

            vi.setSystemTime(1_100);
            await outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
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

    it('uses durable topology snapshots and RTTs across app-outbox workers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);

        try {
            configureTestCacheRepositories();

            const runtimeRepository = new FakeRuntimeStateRepository();
            const appOutboxQueue = new InMemoryQueueBox(new Map());
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
                appOutboxQueue,
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
            await createRtcTopologyOutboxPublisher({
                outboxQueueReader: workerA.outboxQueueReader,
            }).publisher.enqueueForGroupSnapshot(group);

            await workerA.outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
                createResilience(),
            );

            const firstTopology = findSentTopology(workerA.sockets);
            expect(firstTopology?.version).toBe(1);

            const workerB = createTopologyWorker(
                appOutboxQueue,
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
                appOutboxQueue,
                runtimeRepository,
                group,
                'worker-c',
            );

            vi.setSystemTime(1_100);
            await workerC.outboxQueueReader.dequeueOutbox(
                OutboxQueueReader.OUTBOX_DEQUEUE_TYPES,
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

function createRttHarness(
    sessionIds: readonly string[],
    options: Readonly<{
        rtcTopologyOptions?: ConstructorParameters<typeof RallarRtcTopologyService>[0];
        runtimeRepository?: FakeRuntimeStateRepository;
    }> = {},
): {
    readonly sockets: Map<string, FakeSocket>;
    readonly topologyService: RallarRtcTopologyService;
} {
    const server = new JsonWebSocketServer();
    const sockets = createSockets(sessionIds);
    for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
    }

    const service = new WsQueueBoxServerService(
        new InMemoryQueueBox(new Map()),
        new InMemoryQueueBox(new Map()),
        server,
        'server-1',
    );
    const topologyService = new RallarRtcTopologyService(
        options.rtcTopologyOptions,
    );
    initRallarSystemWsTopics(service, {
        rtcTopologyService: topologyService,
        ...(options.runtimeRepository
            ? { rtcTopologyRuntimeState: { repository: options.runtimeRepository } }
            : {}),
    });

    return { sockets, topologyService };
}

async function dispatchRtt(
    socket: FakeSocket,
    senderId: string,
    rtt: Readonly<{
        sessionIdFrom: string;
        sessionIdTo: string;
        rttMs: number;
        createdAtEpochMs: number;
        version: number;
    }>,
    group?: GroupSnapshot,
): Promise<void> {
    await socket.dispatchMessage(
        newALBroadcastMessage(
            senderId,
            newALEventRoute(
                AppTopics.rtt,
                group?.group.groupId ?? 'room-1',
                `rtt-${rtt.version}`,
            ),
            'room',
            AppTopics.rtt,
            rtt,
            group ? { groupRef: group.group } : undefined,
        ),
    );
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

function createTopologyExecutionDependencies(
    runtimeRepository: FakeRuntimeStateRepository,
    server: JsonWebSocketServer,
    publisherId: string,
) {
    const publicationRepository = new RtcTopologyPublicationRepository(
        runtimeRepository,
    );
    return {
        executionRepository: new RtcTopologyExecutionRepository(
            runtimeRepository,
        ),
        publicationFanout: createRtcTopologyPublicationFanout({
            publisherId,
            repository: publicationRepository,
            transport: createDisabledRtcTopologyClusterTransport(),
            server,
        }),
    };
}

function createTopologyWorker(
    appOutboxQueue: InMemoryQueueBox,
    runtimeRepository: FakeRuntimeStateRepository,
    group: GroupSnapshot,
    name: string,
): {
    readonly sockets: Map<string, FakeSocket>;
    readonly senderSocket: FakeSocket;
    readonly outboxQueueReader: OutboxQueueReader;
} {
    const server = new JsonWebSocketServer();
    const sockets = createSockets(
        group.activeSessions.map((session) => session.sessionId),
    );

    for (const [sessionId, socket] of sockets) {
        server.addConnection(new ConnectionContext(sessionId, socket as never));
    }

    const outboxQueueReader = new OutboxQueueReader(appOutboxQueue);
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
        rtcTopologyAppOutbox: {
            outboxQueueReader,
            ...createTopologyExecutionDependencies(
                runtimeRepository,
                server,
                name,
            ),
            findGroupSnapshotByRef: async () => group,
        },
    });

    return {
        sockets,
        senderSocket: sockets.get('session-a')!,
        outboxQueueReader,
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
        stateRevision: 1,
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
        stateRevision: 1,
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
        stateRevision: snapshot.stateRevision + 1,
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
