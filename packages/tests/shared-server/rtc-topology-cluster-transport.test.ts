import { describe, expect, it, vi } from 'vitest';
import {
    ConnectionContext,
    JsonWebSocketServer,
    newALBroadcastMessage,
    newALRoute,
} from '@shared/mod.ts';
import { RtcTopologyPublicationRepository } from '@shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts';
import {
    createLocalRtcTopologyClusterBus,
    createLocalRtcTopologyClusterTransport,
    createRtcTopologyPublicationFanout,
} from '@shared-server/rallar-system/pubsub/RtcTopologyClusterTransport.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('RTC topology cluster publication fanout', () => {
    it('loads a durable publication and delivers only to local recipients on every server', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
        );
        const bus = createLocalRtcTopologyClusterBus();
        const serverA = new JsonWebSocketServer();
        const serverB = new JsonWebSocketServer();
        const socketA = new FakeSocket();
        const socketB = new FakeSocket();
        const outside = new FakeSocket();
        serverA.addConnection(new ConnectionContext('session-a', socketA as never));
        serverB.addConnection(new ConnectionContext('session-b', socketB as never));
        serverB.addConnection(new ConnectionContext('session-c', outside as never));
        const fanoutA = createRtcTopologyPublicationFanout({
            publisherId: 'server-a',
            repository,
            transport: createLocalRtcTopologyClusterTransport(bus),
            server: serverA,
        });
        const fanoutB = createRtcTopologyPublicationFanout({
            publisherId: 'server-b',
            repository,
            transport: createLocalRtcTopologyClusterTransport(bus),
            server: serverB,
        });
        await Promise.all([fanoutA.readiness, fanoutB.readiness]);
        const publication = {
            publicationId: 'publication-1',
            workId: 'work-1',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            sourceGroupStateRevision: 4,
            overlayVersion: 2,
            recipientSessionIds: ['session-a', 'session-b'],
            message: newALBroadcastMessage(
                'server-a',
                newALRoute('overlay-topology', 'room-1', 'publication-1'),
                'room',
                'overlay-topology',
                { sourceGroupStateRevision: 4 },
            ),
            createdAtEpochMs: Date.now(),
        };
        await repository.putOrLoad(publication);

        expect(await fanoutA.publish(publication)).toBe(1);

        expect(socketA.sent).toHaveLength(1);
        expect(socketB.sent).toHaveLength(1);
        expect(outside.sent).toHaveLength(0);
    });

    it('encodes once and sends by recipient id without scanning unrelated connections', async () => {
        const repository = new RtcTopologyPublicationRepository(
            new FakeRuntimeStateRepository(),
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
                createLocalRtcTopologyClusterBus(),
            ),
            server,
        });
        await fanout.readiness;
        const publication = {
            publicationId: 'publication-1',
            workId: 'work-1',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            sourceGroupStateRevision: 4,
            overlayVersion: 2,
            recipientSessionIds: ['session-a', 'session-a', 'missing-session'],
            message: newALBroadcastMessage(
                'server-a',
                newALRoute('overlay-topology', 'room-1', 'publication-1'),
                'room',
                'overlay-topology',
                { sourceGroupStateRevision: 4 },
            ),
            createdAtEpochMs: Date.now(),
        };

        expect(fanout.deliverLocal(publication)).toBe(1);
        expect(encode).toHaveBeenCalledTimes(1);
        expect(trySendEncoded).toHaveBeenCalledTimes(2);
        expect(broadcast).not.toHaveBeenCalled();
    });
});

class FakeSocket {
    readonly readyState = WebSocket.OPEN;
    readonly sent: string[] = [];

    addEventListener(): void {}

    send(value: string): void {
        this.sent.push(value);
    }

    close(): void {}
}
