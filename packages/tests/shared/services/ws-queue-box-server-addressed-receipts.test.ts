import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_RECEIPT_TYPE_ID
} from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    newALAckControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { toWsQueueBoxServerAddresseeAuthorization } from '@shared/services/ws-queue-box-server/to-ws-queue-box-server-addressee-authorization.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** The sessions the room's authority admits; `c` is connected but not a member. */
const ROOM_SESSIONS: readonly string[] = ['a', 'b'];

interface AddressedFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
    /** Every message the stub router took from the service's inbox. */
    readonly routed: ALMessage[];
}

describe('WS server receipts for addressed sends (D53, D57 as applied)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('delivers a room unicast to its addressee through the router and answers the origin with the addressee alone', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-b', 'b', 'receiver'),
            'a'
        );

        expect(admitted.right?.kind).toBe('admitted');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readReceipts(fixture.sockets.a).map((
                receipt
            ) => [receipt.phase, receipt.expectedRecipientPeerIds]);
        }).toEqual([['admitted', ['b']]]);
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readFrames(fixture.sockets.b).map((message) => message.id.msgId);
        }).toEqual(['to-b']);
        expect(fixture.routed.map((message) => message.id.msgId)).toEqual(['to-b']);
        expect(readFrames(fixture.sockets.c)).toEqual([]);
    });

    it('completes the one-member receipt on the addressee\'s own ACK', async () => {
        const fixture = await createAddressedFixture();
        await fixture.service.acceptIncomingMessage(roomUnicast('to-b', 'b', 'receiver'), 'a');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readFrames(fixture.sockets.b).length;
        }).toBe(1);

        const counted = await fixture.service.acceptIncomingMessage(addresseeAck('to-b', 'b'), 'b');

        expect(counted.left).toBeUndefined();
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readReceipts(fixture.sockets.a).map((
                receipt
            ) => [receipt.phase, receipt.confirmedRecipientPeerIds]);
        }).toEqual([['admitted', []], ['complete', ['b']]]);
    });

    it('refuses a room unicast to a session outside the admitted audience before admission, with a NACK (Q5)', async () => {
        const fixture = await createAddressedFixture();

        const refused = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-c', 'c', 'receiver'),
            'a'
        );

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL unicast to-c addresses c, who is not in the audience its room admitted'
        });
        expect(readNacks(fixture.sockets.a).map((nack) => [nack.msgId, nack.reason])).toEqual([[
            'to-c',
            'unauthorized'
        ]]);
        await fixture.engine.executeOnce();
        expect(fixture.routed).toEqual([]);
        expect(readReceipts(fixture.sockets.a)).toEqual([]);
        expect(readFrames(fixture.sockets.c)).toEqual([]);
    });

    it('refuses an out-of-audience addressee with the NACK policy its authorizer was configured with (C3)', () => {
        const refusal = toWsQueueBoxServerAddresseeAuthorization({
            message: roomUnicast('to-c', 'c', 'receiver'),
            serverPeerId: SERVER_ID,
            sendNack: false,
            authorization: {
                authorized: true,
                roomAudience: { recipientPeerIds: ROOM_SESSIONS, snapshotVersion: 3 }
            }
        });

        expect(refusal).toMatchObject({
            authorized: false,
            reason: 'unauthorized',
            sendNack: false
        });
    });

    it('keeps its own ACK for a receiver unicast addressed to itself and opens no aggregate (Q2)', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast('to-server', SERVER_ID, 'receiver'),
            'a'
        );

        expect(admitted.right?.kind).toBe('admitted');
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readAcks(fixture.sockets.a).map((
                ack
            ) => [ack.ackedMsgId, ack.fromPeerId, ack.logicalRecipientPeerId]);
        }).toEqual([['to-server', SERVER_ID, SERVER_ID]]);
        expect(readReceipts(fixture.sockets.a)).toEqual([]);
        expect(fixture.routed.map((message) => message.id.msgId)).toEqual(['to-server']);
    });

    it('acknowledges a hop room unicast to another session itself, as the origin\'s one hop', async () => {
        const fixture = await createAddressedFixture();

        await fixture.service.acceptIncomingMessage(
            roomUnicast('hop-to-b', 'b', 'none', { ack: { algo: 'hop' } }),
            'a'
        );

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readAcks(fixture.sockets.a).map((ack) => [ack.ackedMsgId, ack.fromPeerId]);
        }).toEqual([['hop-to-b', SERVER_ID]]);
        expect(readFrames(fixture.sockets.b).map((message) => message.id.msgId)).toEqual([
            'hop-to-b'
        ]);
    });
});

async function createAddressedFixture(): Promise<AddressedFixture> {
    const socketServer = new JsonWebSocketServer();
    const sockets = {
        a: new SimulatedWebSocket('ws://a'),
        b: new SimulatedWebSocket('ws://b'),
        c: new SimulatedWebSocket('ws://c')
    };
    for (const [peerId, socket] of Object.entries(sockets)) {
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: ROOM_SESSIONS, snapshotVersion: 3 }
                }
                : { authorized: true }
    });
    const routed: ALMessage[] = [];
    // The router's live fanout for a unicast: the addressee, narrowed to the admitted audience.
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            routed.push(message);
            if (message.targets?.mode === 'unicast' && message.targets.toPeerId !== SERVER_ID) {
                service.sendToTargetsWithResult(message, [message.targets.toPeerId], ROOM_SESSIONS);
            }
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets, routed };
}

function roomUnicast(
    msgId: string,
    toPeerId: string,
    ack: 'receiver' | 'none',
    qos?: ALMessage['qos']
): ALMessage {
    const nowMs = Date.now();
    return {
        id: { v: 2, msgId, ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.command', resourceId: msgId, contextId: ROOM.groupId },
        targets: { mode: 'unicast', toPeerId, groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + 30_000 },
        delivery: { reliability: 'at-least-once', ack },
        ...(qos === undefined ? {} : { qos }),
        payload: { typeId: 'command.v1', contentType: 'application/json', resource: '{}' }
    };
}

function addresseeAck(ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function readMessages(socket: SimulatedWebSocket): readonly ALMessage[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame));
}

function readFrames(socket: SimulatedWebSocket): readonly ALMessage[] {
    return readMessages(socket).filter((message) => !message.payload.typeId.startsWith('al.control.'));
}

function readControlPayloads(socket: SimulatedWebSocket, typeId: string): readonly unknown[] {
    return readMessages(socket)
        .filter((message) => message.payload.typeId === typeId)
        .map((message): unknown => JSON.parse(message.payload.resource));
}

function readReceipts(socket: SimulatedWebSocket): readonly ALReceiptPayload[] {
    return readControlPayloads(socket, AL_CONTROL_RECEIPT_TYPE_ID).map((payload) => decodeALReceiptPayload(payload));
}

function readAcks(socket: SimulatedWebSocket): readonly ALAckPayload[] {
    return readControlPayloads(socket, AL_CONTROL_ACK_TYPE_ID) as readonly ALAckPayload[];
}

function readNacks(socket: SimulatedWebSocket): readonly ALNackPayload[] {
    return readControlPayloads(socket, AL_CONTROL_NACK_TYPE_ID) as readonly ALNackPayload[];
}
