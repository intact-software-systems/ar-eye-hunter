import { expect, it, onTestFinished } from 'vitest';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { createDefaultWsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const SCOPE = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

it('delivers a durable admitted room send with omitted fanout and completes its receiver receipt', async () => {
    const socketServer = new JsonWebSocketServer();
    const origin = new TestWebSocket('ws://origin');
    const receiver = new TestWebSocket('ws://receiver');
    origin.open();
    receiver.open();
    socketServer.addConnection(new ConnectionContext({ id: 'origin', socket: origin }));
    socketServer.addConnection(new ConnectionContext({ id: 'receiver', socket: receiver }));
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const service = createDefaultWsQueueBoxServerService({
        outbox: outboundStores.workQueue,
        outboundStores,
        socket: socketServer,
        name: 'server-1',
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: {
            resolvePeerIdForConnection: (connectionId) => connectionId,
            resolvePeerRecipients: (peerId) => [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => [
                { peerId: 'origin', connectionId: 'origin' },
                { peerId: 'receiver', connectionId: 'receiver' }
            ]
        }
    });
    onTestFinished(() => service.dispose());
    const router = new RallarServerWsRouter(service, {
        authorizeRoomMessage: ({ message }) =>
            message.targets === undefined ? false : {
                authorized: true,
                audience: {
                    targets: message.targets,
                    sessions: [roomSession('origin'), roomSession('receiver')],
                    snapshotVersion: 3
                }
            }
    });
    router.install().defineTopic({ topicId: 'room.chat' });
    const nowMs = Date.now();
    const message = {
        ...newALBroadcastMessage('origin', newALRoute('room.chat', ROOM.groupId, 'default-durable'), 'room', 'chat.message.v1', {}, {
            groupRef: ROOM,
            exceptPeerIds: ['origin']
        }),
        id: { v: 2 as const, msgId: 'default-durable', senderId: 'origin', ts: nowMs },
        delivery: { reliability: 'at-least-once' as const, ack: 'receiver' as const }
    };

    origin.receive(JSON.stringify(message));

    await expect.poll(() =>
        receiver.sent
            .map(decodePersistedALMessage)
            .filter((sent) => sent.id.msgId === message.id.msgId).length
    ).toBe(1);
    expect(await outboundStores.admissionStore.readReceiptState({ originPeerId: 'origin', msgId: message.id.msgId }))
        .toMatchObject({ mode: 'receiver', expectedPeerIds: ['receiver'] });

    await service.acceptIncomingMessage(
        newALAckControlMessage(
            { v: 2, msgId: 'receiver-ack', senderId: 'receiver', ts: nowMs },
            {
                ackedMsgId: message.id.msgId,
                fromPeerId: 'receiver',
                toPeerId: 'origin',
                originPeerId: 'origin',
                logicalRecipientPeerId: 'receiver',
                carrier: 'ws',
                status: 'delivered',
                observedAtEpochMs: nowMs
            }
        ),
        'receiver'
    );

    await expect.poll(() =>
        origin.sent
            .map(decodePersistedALMessage)
            .flatMap((sent) => {
                const control = parseALControlMessage(sent);
                return control?.type === 'receipt' ? [control.payload.phase] : [];
            })
    ).toContain('complete');
});

it.each(
    [
        { label: 'explicit live-only', defaultFanout: undefined, publishFanout: 'live-only', status: 'failed' },
        { label: 'configured none', defaultFanout: 'none', publishFanout: undefined, status: 'none' }
    ] as const
)('keeps $label from silently selecting the durable outbox', async ({ defaultFanout, publishFanout, status }) => {
    const outbox = new InMemoryQueueBox(new Map());
    const service = createDefaultWsQueueBoxServerService({
        outbox,
        socket: new JsonWebSocketServer(),
        name: 'server-1'
    });
    onTestFinished(() => service.dispose());
    const router = new RallarServerWsRouter(service, { defaultFanout });
    const message = {
        ...newALBroadcastMessage('server-1', newALRoute('app.chat', 'all', 'durable'), 'all', 'chat.message.v1', {}),
        delivery: { reliability: 'at-least-once' as const, ack: 'receiver' as const }
    };

    const result = await router.publish({ message, fanout: publishFanout });

    expect(result.status).toBe(status);
    expect(result.fanout).toBe(publishFanout ?? defaultFanout);
    expect(await outbox.getAllKeys()).toEqual([]);
});

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
