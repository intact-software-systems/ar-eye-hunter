import { describe, expect, it, onTestFinished } from 'vitest';

import {
    installLiveWsNoticeSubscriber,
    type LiveWsNoticeSendInputDto
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice-subscriber.ts';
import type {
    LiveWsNotice,
    LiveWsNoticeTransport
} from '@shared-server/rallar-system/queue-pubsub/live-ws-notice.ts';
import type { RallarServerWsFanout } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router-contracts.ts';
import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const SCOPE = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

const QOS_CASES = [
    { qos: 'best-effort', reliability: 'best-effort', ack: 'none' },
    { qos: 'at-least-once', reliability: 'at-least-once', ack: 'receiver' }
] as const;

type QosCase = (typeof QOS_CASES)[number];

interface CarrierFixture {
    readonly router: RallarServerWsRouter;
    readonly receiver: TestWebSocket;
    readonly notices: LiveWsNotice[];
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

describe('Rallar server WS fanout carriers', () => {
    it.each(QOS_CASES)(
        'sends a $qos publish on a live-only fanout once to the local sockets',
        async (qosCase) => {
            const fixture = createCarrierFixture(false);
            const message = createRoomBroadcast('server-1', `live-only-${qosCase.qos}`, qosCase);

            const result = await fixture.router.publish({ message, fanout: 'live-only' });

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'sent-live',
                sentCount: 1,
                entries: []
            });
            expect(readReceivedMsgIds(fixture.receiver)).toEqual([message.id.msgId]);
            expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
                .toBeUndefined();
        }
    );

    it.each(QOS_CASES)(
        'publishes a $qos message on a live-only fanout as one cluster notice',
        async (qosCase) => {
            const fixture = createCarrierFixture(true);
            const message = createRoomBroadcast('server-1', `cluster-${qosCase.qos}`, qosCase);

            const result = await fixture.router.publish({ message, fanout: 'live-only' });

            expect(result).toMatchObject({
                fanout: 'live-only',
                status: 'cluster-published',
                entries: []
            });
            expect(fixture.notices).toHaveLength(1);
            expect(fixture.notices[0]).toMatchObject({
                delivery: 'inline',
                message: { id: message.id }
            });
            expect(readReceivedMsgIds(fixture.receiver)).toEqual([message.id.msgId]);
            expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
                .toBeUndefined();
        }
    );

    it.each(QOS_CASES)(
        'admits a $qos publish on an outbox fanout as a server outbox row',
        async (qosCase) => {
            const fixture = createCarrierFixture(true);
            const message = createRoomBroadcast('server-1', `outbox-${qosCase.qos}`, qosCase);

            const result = await fixture.router.publish({ message, fanout: 'outbox' });

            expect(result).toMatchObject({ fanout: 'outbox', status: 'queued-outbox' });
            expect(fixture.notices).toEqual([]);
            expect(
                (await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))?.msg
                    .id
            )
                .toEqual(message.id);
        }
    );

    it.each(QOS_CASES)(
        'runs only the handlers for a $qos publish on a none fanout',
        async (qosCase) => {
            const fixture = createCarrierFixture(true);
            const message = createRoomBroadcast('server-1', `none-${qosCase.qos}`, qosCase);

            const result = await fixture.router.publish({ message, fanout: 'none' });

            expect(result).toMatchObject({
                fanout: 'none',
                status: 'none',
                sentCount: 0,
                entries: []
            });
            expect(fixture.notices).toEqual([]);
            expect(readReceivedMsgIds(fixture.receiver)).toEqual([]);
            expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
                .toBeUndefined();
        }
    );

    it('refuses an oversized at-least-once live-only publish without upgrading it to the outbox', async () => {
        const fixture = createCarrierFixture(true);
        const base = createRoomBroadcast('server-1', 'oversized-live', QOS_CASES[1]);
        const message = {
            ...base,
            payload: { ...base.payload, resource: JSON.stringify('x'.repeat(9_000)) }
        };

        const result = await fixture.router.publish({ message, fanout: 'live-only' });

        expect(result).toMatchObject({ fanout: 'live-only', status: 'failed', entries: [] });
        expect(result.reason).toContain('oversized');
        expect(fixture.notices).toEqual([]);
        expect(readReceivedMsgIds(fixture.receiver)).toEqual([]);
        expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
            .toBeUndefined();
    });

    it('carries an admitted at-least-once room send to a remote socket owner with its id, deadline and ack policy', async () => {
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
        const remoteSends: LiveWsNoticeSendInputDto[] = [];
        await installLiveWsNoticeSubscriber({
            transport,
            channel: 'ws-channel',
            publisherId: 'server-b',
            nowMs: () => Date.now(),
            inboundStores: [],
            resolveBroadRecipientSessionIds: () => [],
            filterEligibleRecipientSessionIds: (sessionIds) => sessionIds,
            sendToTargetsWithResult: (delivery) => {
                remoteSends.push(delivery);
            }
        });
        const service = createDefaultWsQueueBoxServerService({
            outbox: new InMemoryQueueBox(new Map()),
            socket: new JsonWebSocketServer(),
            name: 'server-1'
        });
        onTestFinished(() => service.dispose());
        const router = new RallarServerWsRouter(service, {
            authorizeRoomMessage: ({ message }) =>
                message.targets === undefined ? false : {
                    authorized: true,
                    audience: {
                        targets: message.targets,
                        sessions: [roomSession('sender'), roomSession('remote-session')],
                        snapshotVersion: 3
                    }
                },
            livePublication: { transport, channel: 'ws-channel', publisherId: 'server-a' }
        });
        router.defineTopic({ topicId: 'room.carrier' });
        const message = createRoomBroadcast('sender', 'admitted-remote', QOS_CASES[1]);

        await router.route(message, {
            kind: 'ws-client',
            peerId: 'sender',
            authenticatedScope: SCOPE,
            groupRecipientPeerIds: ['remote-session']
        });

        expect(remoteSends).toHaveLength(1);
        expect(remoteSends[0]!.recipientSessionIds).toEqual(['remote-session']);
        expect(remoteSends[0]!.message).toEqual(message);
        expect(remoteSends[0]!.message.delivery).toEqual({
            reliability: 'at-least-once',
            ack: 'receiver'
        });
        expect(remoteSends[0]!.notice.expiresAtMs).toBeLessThanOrEqual(
            message.constraints!.expiresAtMs!
        );
    });

    it.each(
        [
            { defaultFanout: undefined, fanout: 'live-only', status: 'sent-live' },
            { defaultFanout: 'none', fanout: 'none', status: 'none' },
            { defaultFanout: 'outbox', fanout: 'outbox', status: 'queued-outbox' }
        ] as const
    )(
        'uses the $fanout router default for an at-least-once publish that names no fanout',
        async (row) => {
            const fixture = createCarrierFixture(false, row.defaultFanout);
            const message = createRoomBroadcast('server-1', `default-${row.fanout}`, QOS_CASES[1]);

            const result = await fixture.router.publish({ message });

            expect(result).toMatchObject({ fanout: row.fanout, status: row.status });
        }
    );
});

function createCarrierFixture(
    cluster: boolean,
    defaultFanout?: RallarServerWsFanout
): CarrierFixture {
    const socketServer = new JsonWebSocketServer();
    const receiver = new TestWebSocket('ws://receiver');
    receiver.open();
    socketServer.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const service = createDefaultWsQueueBoxServerService({
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: socketServer,
        name: 'server-1',
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => [{ peerId: 'receiver', connectionId: 'receiver' }]
        }
    });
    onTestFinished(() => service.dispose());
    const notices: LiveWsNotice[] = [];
    const router = new RallarServerWsRouter(service, {
        defaultFanout,
        readServerPublishAudience: async (message) => ({
            targets: message.targets!,
            sessions: [roomSession('receiver')],
            snapshotVersion: 3
        }),
        livePublication: cluster
            ? {
                transport: {
                    publish: async (notice) => {
                        notices.push(notice);
                    },
                    subscribe: async () => {}
                },
                channel: 'ws-channel',
                publisherId: 'server-a'
            }
            : undefined
    });
    return { router, receiver, notices, outboundStores };
}

function createRoomBroadcast(senderId: string, resourceId: string, qosCase: QosCase): ALMessage {
    return newALBroadcastMessage(
        senderId,
        newALRoute('room.carrier', ROOM.groupId, resourceId),
        'room',
        'room.carrier.v1',
        { resourceId },
        { groupRef: ROOM, reliability: qosCase.reliability, ack: qosCase.ack, ttlMs: 30_000 }
    );
}

function roomSession(sessionId: string): GroupPresenceSession {
    return {
        applicationId: ROOM.applicationId,
        workspaceId: ROOM.workspaceId,
        groupId: ROOM.groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 3,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 3,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function readReceivedMsgIds(socket: TestWebSocket): readonly string[] {
    return socket.sent.map((sent) => decodePersistedALMessage(sent).id.msgId);
}
