import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_RECEIPT_TYPE_ID
} from '@shared/al-contracts/al-control-type-ids.ts';
import {
    decodeALAckPayload,
    decodeALNackPayload,
    decodeALReceiptPayload
} from '@shared/al-contracts/al-control-value-codec.ts';
import {
    newALAckControlMessage,
    type ALAckPayload,
    type ALNackPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
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
const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
/** The sessions the room's authority admits; `c` is connected but not a member. */
const ROOM_SESSIONS: readonly string[] = ['a', 'b'];

interface AddressedFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
    /** Every message the stub router took from the service's inbox. */
    readonly routed: ALMessage[];
}

interface RoomUnicastInput {
    readonly msgId: string;
    readonly toPeerId: string;
    readonly ack: 'receiver' | 'none';
    readonly qos?: ALMessage['qos'];
}

describe('WS server receipts for addressed sends', () => {
    afterEach(() => vi.restoreAllMocks());

    it('delivers a room unicast to its addressee through the router and answers the origin with the addressee alone', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast({ msgId: 'to-b', toPeerId: 'b', ack: 'receiver' }),
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
        await fixture.service.acceptIncomingMessage(roomUnicast({ msgId: 'to-b', toPeerId: 'b', ack: 'receiver' }), 'a');
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

    it('refuses a room unicast to a session outside the admitted audience before admission, with a NACK', async () => {
        const fixture = await createAddressedFixture();

        const refused = await fixture.service.acceptIncomingMessage(
            roomUnicast({ msgId: 'to-c', toPeerId: 'c', ack: 'receiver' }),
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

    it('follows the authorizer NACK policy when refusing an out-of-audience addressee', async () => {
        const fixture = await createAddressedFixture(false);

        const refused = await fixture.service.acceptIncomingMessage(
            roomUnicast({ msgId: 'to-c', toPeerId: 'c', ack: 'receiver' }),
            'a'
        );

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL unicast to-c addresses c, who is not in the audience its room admitted'
        });
        expect(readNacks(fixture.sockets.a)).toEqual([]);
        await fixture.engine.executeOnce();
        expect(fixture.routed).toEqual([]);
    });

    it('keeps its own ACK for a receiver unicast addressed to itself and opens no aggregate', async () => {
        const fixture = await createAddressedFixture();

        const admitted = await fixture.service.acceptIncomingMessage(
            roomUnicast({ msgId: 'to-server', toPeerId: SERVER_ID, ack: 'receiver' }),
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
            roomUnicast({ msgId: 'hop-to-b', toPeerId: 'b', ack: 'none', qos: { ack: { algo: 'hop' } } }),
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

    it('acknowledges a subtree room send itself: the router owns the fanout, so no subtree is waited for', async () => {
        const fixture = await createAddressedFixture();
        const roomSend: ALMessage = {
            ...roomUnicast({ msgId: 'subtree-room', toPeerId: 'b', ack: 'none' }),
            targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
            delivery: { reliability: 'at-least-once', ack: 'group-leader' }
        };

        await fixture.service.acceptIncomingMessage(roomSend, 'a');

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readAcks(fixture.sockets.a).map((ack) => [ack.ackedMsgId, ack.fromPeerId]);
        }).toEqual([['subtree-room', SERVER_ID]]);
    });

    it('aggregates a handed-over message over the audience its RTC leg froze, so a leaver reads unconfirmed', async () => {
        const fixture = await createAddressedFixture();
        const handedOver: ALMessage = {
            ...roomUnicast({ msgId: 'frozen-1', toPeerId: 'b', ack: 'receiver' }),
            targets: {
                mode: 'multicast',
                groupRef: ROOM,
                recipientPeerIds: ['b', 'd'],
                snapshotVersion: 2
            }
        };

        await fixture.service.acceptIncomingMessage(handedOver, 'a');

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readReceipts(fixture.sockets.a).map((receipt) => receipt.expectedRecipientPeerIds);
        }).toEqual([['b', 'd']]);
    });
});

async function createAddressedFixture(sendNacks = true): Promise<AddressedFixture> {
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
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Date.now() + 60_000 }
                : undefined,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    service.authorizeInboundMessagesWith({
        sendNacks,
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
                service.sendToTargetsWithResult({
                    message,
                    recipientSessionIds: [message.targets.toPeerId],
                    admittedPeerIds: ROOM_SESSIONS,
                    inboundScope: SCOPE
                });
            }
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets, routed };
}

function roomUnicast(input: RoomUnicastInput): ALMessage {
    const { msgId, toPeerId, ack, qos } = input;
    const nowMs = Date.now();
    return {
        id: { v: 3, msgId, ts: nowMs, senderId: 'a' },
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
        { v: 3, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now() },
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
    return readControlPayloads(socket, AL_CONTROL_ACK_TYPE_ID).map((payload) => decodeALAckPayload(payload));
}

function readNacks(socket: SimulatedWebSocket): readonly ALNackPayload[] {
    return readControlPayloads(socket, AL_CONTROL_NACK_TYPE_ID).map((payload) => decodeALNackPayload(payload));
}
