import {
    createLocalRtcTopologyClusterBus,
    createLocalRtcTopologyClusterTransport,
    createRtcTopologyPublicationFanout,
    isRtcTopologyPublicationNotification
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import {
    hashRtcTopologyExecutionCommand,
    RtcTopologyPublicationRepository,
    type RtcTopologyPublication
} from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import { RtcTopologySnapshotRepository } from '@shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts';
import { toRtcTopologyPublicationMessageId } from '@shared-server/rallar-system/rtc-topology-identifiers.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { ConnectionContext, JsonWebSocketServer, newALBroadcastMessage, newALRoute } from '@shared/mod.ts';
import { describe, expect, it, vi } from 'vitest';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology cluster publication fanout', () => {
    it('loads a durable publication and delivers only to local recipients on every server', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtime);
        const bus = createLocalRtcTopologyClusterBus();
        const serverA = new JsonWebSocketServer();
        const serverB = new JsonWebSocketServer();
        const socketA = new FakeSocket();
        const socketB = new FakeSocket();
        const outside = new FakeSocket();
        serverA.addConnection(new ConnectionContext('session-a', socketA as never));
        serverB.addConnection(new ConnectionContext('session-b', socketB as never));
        serverB.addConnection(new ConnectionContext('session-c', outside as never));
        const transportA = createLocalRtcTopologyClusterTransport(bus);
        const publishNotification = vi.spyOn(transportA, 'publish');
        const fanoutA = createRtcTopologyPublicationFanout({
            publisherId: 'server-a',
            repository,
            transport: transportA,
            server: serverA
        });
        const fanoutB = createRtcTopologyPublicationFanout({
            publisherId: 'server-b',
            repository,
            transport: createLocalRtcTopologyClusterTransport(bus),
            server: serverB
        });
        await Promise.all([fanoutA.readiness, fanoutB.readiness]);
        const snapshot = topologySnapshot(['session-a', 'session-b']);
        const message = topologyPublicationMessage(snapshot, 'work-1');
        const publication = {
            publicationId: 'work-1:4:0:2',
            workId: 'work-1',
            groupRef: snapshot.groupRef,
            sourceGroupStateCausalRevision: {
                groupRevision: 4,
                presenceRevision: 0
            },
            overlayVersion: 2,
            targetGroupSnapshotVersion: 1,
            recipientSessionIds: ['session-a', 'session-b'],
            message,
            createdAtEpochMs: message.id.ts
        };
        await putOrLoadPublication(repository, runtime, snapshot, publication);

        expect(await fanoutA.publish(publication)).toBe(1);

        expect(socketA.sent).toHaveLength(1);
        expect(socketB.sent).toHaveLength(1);
        expect(outside.sent).toHaveLength(0);
        expect(publishNotification).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                v: 2,
                groupRef: snapshot.groupRef,
                publicationId: publication.publicationId
            })
        );
    });

    it('accepts exact legacy v1 notifications through validated global lookup', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtime);
        const bus = createLocalRtcTopologyClusterBus();
        const transport = createLocalRtcTopologyClusterTransport(bus);
        const server = new JsonWebSocketServer();
        const socket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-b', socket as never));
        const fanout = createRtcTopologyPublicationFanout({
            publisherId: 'server-b',
            repository,
            transport,
            server
        });
        await fanout.readiness;
        const snapshot = topologySnapshot(['session-b']);
        const message = topologyPublicationMessage(snapshot, 'work-legacy');
        const publication = {
            publicationId: 'work-legacy:4:0:2',
            workId: 'work-legacy',
            groupRef: snapshot.groupRef,
            sourceGroupStateCausalRevision: {
                groupRevision: 4,
                presenceRevision: 0
            },
            overlayVersion: 2,
            targetGroupSnapshotVersion: 1,
            recipientSessionIds: ['session-b'],
            message,
            createdAtEpochMs: message.id.ts
        };
        await putOrLoadPublication(repository, runtime, snapshot, publication);

        await transport.publish('rallar_rtc_topology_publication', {
            v: 1,
            publisherId: 'server-a',
            publicationId: publication.publicationId,
            sourceGroupStateRevision: 4
        });

        expect(socket.sent).toHaveLength(1);
        expect(isRtcTopologyPublicationNotification({
            v: 1,
            publisherId: 'server-a',
            groupRef: snapshot.groupRef,
            publicationId: publication.publicationId,
            sourceGroupStateRevision: 4
        })).toBe(false);
    });

    it('uses v2 scope to distinguish required workspace values', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = new RtcTopologyPublicationRepository(runtime);
        const bus = createLocalRtcTopologyClusterBus();
        const transport = createLocalRtcTopologyClusterTransport(bus);
        const server = new JsonWebSocketServer();
        const absentSocket = new FakeSocket();
        const literalSocket = new FakeSocket();
        server.addConnection(new ConnectionContext('session-absent', absentSocket as never));
        server.addConnection(new ConnectionContext('session-literal', literalSocket as never));
        const fanout = createRtcTopologyPublicationFanout({
            publisherId: 'server-b',
            repository,
            transport,
            server
        });
        await fanout.readiness;
        const absentRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-absent',
            groupId: 'room-1'
        };
        const literalRef = {
            applicationId: 'app-1',
            workspaceId: '_',
            groupId: 'room-1'
        };
        const absentSnapshot = topologySnapshotForGroup(['session-absent'], absentRef);
        const literalSnapshot = topologySnapshotForGroup(['session-literal'], literalRef);
        const publicationId = 'work-scoped:4:0:2';
        for (
            const [workId, snapshot, recipient] of [
                ['work-scoped', absentSnapshot, 'session-absent'],
                ['work-scoped', literalSnapshot, 'session-literal']
            ] as const
        ) {
            const message = topologyPublicationMessage(snapshot, workId);
            await putOrLoadPublication(repository, runtime, snapshot, {
                publicationId,
                workId,
                groupRef: snapshot.groupRef,
                sourceGroupStateCausalRevision: {
                    groupRevision: 4,
                    presenceRevision: 0
                },
                overlayVersion: 2,
                targetGroupSnapshotVersion: 1,
                recipientSessionIds: [recipient],
                message,
                createdAtEpochMs: message.id.ts
            });
        }

        await transport.publish('rallar_rtc_topology_publication', {
            v: 2,
            publisherId: 'server-a',
            groupRef: literalRef,
            publicationId,
            sourceGroupStateCausalRevision: {
                groupRevision: 4,
                presenceRevision: 0
            }
        });

        expect(absentSocket.sent).toHaveLength(0);
        expect(literalSocket.sent).toHaveLength(1);
    });

    it('encodes once and sends by recipient id without scanning unrelated connections', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository()
        );
        const server = new JsonWebSocketServer();
        server.addConnection(new ConnectionContext('session-a', new FakeSocket() as never));
        server.addConnection(new ConnectionContext('session-outside', new FakeSocket() as never));
        const encode = vi.spyOn(server, 'encode');
        const trySendEncoded = vi.spyOn(server, 'trySendEncoded');
        const broadcast = vi.spyOn(server, 'broadcast');
        const fanout = createRtcTopologyPublicationFanout({
            publisherId: 'server-a',
            repository,
            transport: createLocalRtcTopologyClusterTransport(
                createLocalRtcTopologyClusterBus()
            ),
            server
        });
        await fanout.readiness;
        const publication = {
            publicationId: 'work-1:4:0:2',
            workId: 'work-1',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            sourceGroupStateCausalRevision: {
                groupRevision: 4,
                presenceRevision: 0
            },
            overlayVersion: 2,
            targetGroupSnapshotVersion: 1,
            recipientSessionIds: ['session-a', 'session-a', 'missing-session'],
            message: newALBroadcastMessage(
                'server-a',
                newALRoute('overlay-topology', 'room-1', 'publication-1'),
                'room',
                'overlay-topology',
                {
                    sourceGroupStateCausalRevision: {
                        groupRevision: 4,
                        presenceRevision: 0
                    }
                }
            ),
            createdAtEpochMs: Date.now()
        };

        expect(fanout.deliverLocal(publication)).toBe(1);
        expect(encode).toHaveBeenCalledTimes(1);
        expect(trySendEncoded).toHaveBeenCalledTimes(2);
        expect(broadcast).not.toHaveBeenCalled();
    });
});

async function putOrLoadPublication(
    repository: RtcTopologyPublicationRepository,
    runtime: FakeRuntimeStateRepository,
    snapshot: RallarOverlayTopologySnapshot,
    publication: RtcTopologyPublication
) {
    const snapshots = new RtcTopologySnapshotRepository(runtime);
    await snapshots.observeSnapshot(snapshot);
    const accepted = await snapshots.findSnapshotEntry(snapshot.groupRef);
    if (!accepted) {
        throw new Error('Expected accepted topology snapshot fixture');
    }
    return await repository.putOrLoad(publication, {
        commandHash: await hashRtcTopologyExecutionCommand(publication),
        attemptCount: 1,
        acceptedStorageRevision: accepted.entry.revision
    });
}

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    readonly sent: string[] = [];

    addEventListener(): void {}

    send(value: string): void {
        this.sent.push(value);
    }

    close(): void {}
}

function topologySnapshot(activeSessionIds: readonly string[]) {
    return topologySnapshotForGroup(activeSessionIds, {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room-1'
    });
}

function topologyPublicationMessage(
    snapshot: RallarOverlayTopologySnapshot,
    workId: string
) {
    const message = newALBroadcastMessage(
        'rallar-server',
        newALRoute(
            AppTopics.overlayTopology,
            snapshot.groupRef.groupId,
            `${snapshot.overlayId}:${snapshot.sourceGroupStateCausalRevision.groupRevision}:${snapshot.sourceGroupStateCausalRevision.presenceRevision}:${snapshot.version}`
        ),
        'room',
        AppTopics.overlayTopology,
        snapshot,
        {
            groupRef: snapshot.groupRef,
            minSnapshotVersion: 1,
            reliability: 'best-effort',
            ack: 'none'
        }
    );
    return JSON.parse(JSON.stringify({
        ...message,
        id: {
            ...message.id,
            msgId: toRtcTopologyPublicationMessageId(workId)
        }
    }));
}

function topologySnapshotForGroup(
    activeSessionIds: readonly string[],
    groupRef: GroupRef
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: 4,
            presenceRevision: 0
        },
        state: 'active' as const,
        overlayId: JSON.stringify([
            groupRef.applicationId,
            groupRef.workspaceId ?? '',
            groupRef.groupId
        ]),
        groupRef,
        name: 'Room 1',
        topology: 'tree' as const,
        activeSessionIds,
        nextHopsBySessionId: Object.fromEntries(
            activeSessionIds.map((sessionId) => [
                sessionId,
                activeSessionIds.filter((peer) => peer !== sessionId)
            ])
        ),
        degreeLimit: 2,
        version: 2,
        createdByClientId: 'owner',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2
    };
}
