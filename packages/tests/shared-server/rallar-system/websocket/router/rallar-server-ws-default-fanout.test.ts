import { expect, it, onTestFinished } from 'vitest';

import { RallarServerWsRouter } from '@shared-server/rallar-system/websocket/router/rallar-server-ws-router.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage, parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { TestWebSocket } from '../../../../shared/websocket/test-web-socket.ts';

const ROOM: GroupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' };
const SCOPE = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

interface LiveRoomFixture {
    readonly service: WsQueueBoxServerService;
    readonly origin: TestWebSocket;
    readonly receivers: Readonly<Record<string, TestWebSocket>>;
    readonly outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>;
}

interface OriginReceipt {
    readonly phase: string;
    readonly expected: readonly string[];
    readonly confirmed: readonly string[];
}

it('sends an at-least-once room send on an undeclared fanout live once and completes its receiver receipt', async () => {
    const fixture = createLiveRoomFixture(['receiver']);
    const nowMs = Date.now();
    const message = createReceiverRoomSend('default-live', nowMs, undefined);

    fixture.origin.receive(JSON.stringify(message));

    await expect.poll(() => readDeliveredCount(fixture.receivers['receiver']!, message.id.msgId))
        .toBe(1);
    await expect.poll(() => readOriginReceipts(fixture.origin).length).toBe(1);
    expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
        .toBeUndefined();

    await fixture.service.acceptIncomingMessage(
        createReceiverAck(message.id.msgId, 'receiver', nowMs),
        'receiver'
    );

    await expect.poll(() => readOriginReceipts(fixture.origin)).toEqual([
        { phase: 'admitted', expected: ['receiver'], confirmed: [] },
        { phase: 'complete', expected: ['receiver'], confirmed: ['receiver'] }
    ]);
    expect(readDeliveredCount(fixture.receivers['receiver']!, message.id.msgId)).toBe(1);
});

it('ends the receipt of a live-only at-least-once room send timed out, naming the recipient that never confirmed', async () => {
    const fixture = createLiveRoomFixture(['receiver-a', 'receiver-b']);
    const nowMs = Date.now();
    const message = createReceiverRoomSend('live-timeout', nowMs, nowMs + 400);

    fixture.origin.receive(JSON.stringify(message));
    await expect.poll(() => readDeliveredCount(fixture.receivers['receiver-b']!, message.id.msgId))
        .toBe(1);
    await expect.poll(() => readOriginReceipts(fixture.origin).length).toBe(1);
    await fixture.service.acceptIncomingMessage(
        createReceiverAck(message.id.msgId, 'receiver-a', nowMs),
        'receiver-a'
    );

    await expect.poll(() => readOriginReceipts(fixture.origin), { timeout: 5_000 }).toEqual([
        { phase: 'admitted', expected: ['receiver-a', 'receiver-b'], confirmed: [] },
        { phase: 'timed-out', expected: ['receiver-a', 'receiver-b'], confirmed: ['receiver-a'] }
    ]);
    expect(readDeliveredCount(fixture.receivers['receiver-a']!, message.id.msgId)).toBe(1);
    expect(readDeliveredCount(fixture.receivers['receiver-b']!, message.id.msgId)).toBe(1);
    expect(await fixture.outboundStores.admissionStore.readSentMessage(message.id.msgId))
        .toBeUndefined();
});

it('sends a room send with a fixed list live to the listed receiver alone and expects it alone', async () => {
    const fixture = createLiveRoomFixture(['receiver-a', 'receiver-b']);
    const message: ALMessage = {
        ...createReceiverRoomSend('listed-live', Date.now(), undefined),
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM, exceptPeerIds: ['origin'], recipientPeerIds: ['receiver-a'] }
    };

    fixture.origin.receive(JSON.stringify(message));

    await expect.poll(() => readDeliveredCount(fixture.receivers['receiver-a']!, message.id.msgId))
        .toBe(1);
    await expect.poll(() => readOriginReceipts(fixture.origin)).toEqual([
        { phase: 'admitted', expected: ['receiver-a'], confirmed: [] }
    ]);
    expect(readDeliveredCount(fixture.receivers['receiver-b']!, message.id.msgId)).toBe(0);
});

function createLiveRoomFixture(receiverIds: readonly string[]): LiveRoomFixture {
    const socketServer = new JsonWebSocketServer();
    const origin = new TestWebSocket('ws://origin');
    origin.open();
    socketServer.addConnection(new ConnectionContext({ id: 'origin', socket: origin }));
    const receivers: Record<string, TestWebSocket> = {};
    for (const receiverId of receiverIds) {
        const receiver = new TestWebSocket(`ws://${receiverId}`);
        receiver.open();
        socketServer.addConnection(new ConnectionContext({ id: receiverId, socket: receiver }));
        receivers[receiverId] = receiver;
    }
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    });
    const peerIds = ['origin', ...receiverIds];
    const service = createLiveRoomService(socketServer, outboundStores, peerIds);
    const router = new RallarServerWsRouter(service, {
        authorizeRoomMessage: ({ message }) =>
            message.targets === undefined ? false : {
                authorized: true,
                audience: {
                    targets: message.targets,
                    sessions: peerIds.map(roomSession),
                    snapshotVersion: 3
                }
            }
    });
    router.install().defineTopic({ topicId: 'room.chat' });
    return { service, origin, receivers, outboundStores };
}

function createLiveRoomService(
    socketServer: JsonWebSocketServer,
    outboundStores: ALOutboundRuntimeStores<WsQueueBoxServerPreparedMessage>,
    peerIds: readonly string[]
): WsQueueBoxServerService {
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
            resolveBroadcastRecipients: () => peerIds.map((peerId) => ({ peerId, connectionId: peerId }))
        }
    });
    onTestFinished(() => service.dispose());
    return service;
}

function createReceiverRoomSend(
    msgId: string,
    nowMs: number,
    expiresAtMs: number | undefined
): ALMessage {
    const base = newALBroadcastMessage(
        'origin',
        newALRoute('room.chat', ROOM.groupId, msgId),
        'room',
        'chat.message.v1',
        {},
        {
            groupRef: ROOM,
            exceptPeerIds: ['origin']
        }
    );
    return {
        ...base,
        id: { v: 3, msgId, senderId: 'origin', ts: nowMs },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        ...(expiresAtMs === undefined ? {} : { constraints: { ...base.constraints, expiresAtMs } })
    };
}

function createReceiverAck(ackedMsgId: string, recipientId: string, nowMs: number): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: `${recipientId}-ack-${ackedMsgId}`, senderId: recipientId, ts: nowMs },
        {
            ackedMsgId,
            fromPeerId: recipientId,
            toPeerId: 'origin',
            originPeerId: 'origin',
            logicalRecipientPeerId: recipientId,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: nowMs
        }
    );
}

function readDeliveredCount(socket: TestWebSocket, msgId: string): number {
    return socket.sent.map(decodePersistedALMessage).filter((sent) => sent.id.msgId === msgId)
        .length;
}

function readOriginReceipts(origin: TestWebSocket): readonly OriginReceipt[] {
    return origin.sent.map(decodePersistedALMessage).flatMap((sent) => {
        const control = parseALControlMessage(sent);
        return control?.type === 'receipt'
            ? [{
                phase: control.payload.phase,
                expected: control.payload.expectedRecipientPeerIds,
                confirmed: control.payload.confirmedRecipientPeerIds
            }]
            : [];
    });
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
