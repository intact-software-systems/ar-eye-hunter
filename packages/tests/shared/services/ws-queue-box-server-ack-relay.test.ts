import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    newALAckControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { Either } from '@shared/resilience/Either.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import type { WsServerAckRelayPublisher } from '@shared/services/ws-queue-box-server/ws-queue-box-server-ack-relay.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import {
    ConnectionContext,
    JsonWebSocketServer
} from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SCOPE = { applicationId: ROOM.applicationId, workspaceId: ROOM.workspaceId };

interface ServerInstance {
    readonly service: WsQueueBoxServerService;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
    /** Every ACK this instance handed to the others. */
    readonly relayed: ALMessage[];
}

interface ServerInstanceInput {
    readonly peerIds: readonly string[];
    /** `none`: a single-instance deployment; `fails`: the notice channel is down. */
    readonly relay: 'to-peers' | 'fails' | 'none';
    readonly peers: ServerInstance[];
}

describe('WS server ACK relay across instances', () => {
    it('counts an ACK received on another instance once, through the relay, and completes the receipt', async () => {
        const { owner, other } = await createCluster();
        await admitRoomMessage(owner, Date.now() + 30_000);
        await owner.service.acceptIncomingMessage(receiverAck('b'), 'b');

        const accepted = await other.service.acceptIncomingMessage(receiverAck('c'), 'c');

        expect(accepted.right).toEqual({ kind: 'control', handled: false });
        expect(other.relayed.map((message) => message.id.msgId)).toEqual(['ack-c']);
        await expect.poll(() => readReceipts(owner.sockets.a!)).toEqual([
            { phase: 'admitted', expected: ['b', 'c'], confirmed: [] },
            { phase: 'complete', expected: ['b', 'c'], confirmed: ['b', 'c'] }
        ]);
    });

    it('never relays an ACK its own aggregate counts', async () => {
        const { owner } = await createCluster();
        await admitRoomMessage(owner, Date.now() + 30_000);

        const accepted = await owner.service.acceptIncomingMessage(receiverAck('b'), 'b');

        expect(accepted.right?.kind).toBe('control');
        expect(owner.relayed).toEqual([]);
    });

    it('drops a relayed ACK from a session outside the frozen audience', async () => {
        const { owner, other } = await createCluster();
        await admitRoomMessage(owner, Date.now() + 30_000);

        expect((await other.service.acceptIncomingMessage(receiverAck('d'), 'd')).right)
            .toEqual({ kind: 'control', handled: false });
        await owner.service.acceptIncomingMessage(receiverAck('b'), 'b');
        await other.service.acceptIncomingMessage(receiverAck('c'), 'c');

        await expect.poll(() => readReceipts(owner.sockets.a!)).toEqual([
            { phase: 'admitted', expected: ['b', 'c'], confirmed: [] },
            { phase: 'complete', expected: ['b', 'c'], confirmed: ['b', 'c'] }
        ]);
        expect(other.relayed.map((message) => message.id.msgId)).toEqual(['ack-d', 'ack-c']);
    });

    it('counts a relayed ACK once when it arrives twice', async () => {
        const { owner, other } = await createCluster();
        await admitRoomMessage(owner, Date.now() + 30_000);
        await other.service.acceptIncomingMessage(receiverAck('c'), 'c');

        await owner.service.acceptRelayedAck(receiverAck('c'));
        await owner.service.acceptIncomingMessage(receiverAck('b'), 'b');

        await expect.poll(() => readReceipts(owner.sockets.a!)).toEqual([
            { phase: 'admitted', expected: ['b', 'c'], confirmed: [] },
            { phase: 'complete', expected: ['b', 'c'], confirmed: ['c', 'b'] }
        ]);
    });

    it('drops without an answer a relayed ACK on an instance that holds no aggregate, and never relays it again', async () => {
        const { other } = await createCluster();

        await other.service.acceptRelayedAck(receiverAck('c'));

        expect(other.relayed).toEqual([]);
        expect(other.sockets.c!.sent).toEqual([]);
    });

    it.each([
        {
            label: 'speaks for another recipient',
            ack: { fromPeerId: 'c', logicalRecipientPeerId: 'b', toPeerId: 'a' },
            reason: 'AL acknowledgement from a WS session speaks for another recipient than its sender'
        },
        {
            label: 'is not addressed to the origin it names',
            ack: { fromPeerId: 'c', logicalRecipientPeerId: 'c', toPeerId: 'b' },
            reason: 'AL acknowledgement is not addressed to the origin it names'
        }
    ])('refuses at ingress, before any relay, an ACK that $label', async ({ ack, reason }) => {
        const { owner, other } = await createCluster();
        await admitRoomMessage(owner, Date.now() + 30_000);

        const refused = await other.service.acceptIncomingMessage(receiverAck('c', ack), 'c');

        expect(refused.left).toEqual({ code: 'unauthorized', message: reason });
        expect(other.relayed).toEqual([]);
    });

    it('refuses an ACK no aggregate counts, as before, on an instance with no relay', async () => {
        const single = await createServerInstance({ peerIds: ['c'], relay: 'none', peers: [] });

        const refused = await single.service.acceptIncomingMessage(receiverAck('c'), 'c');

        expect(refused.left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement names no receipt this server aggregates'
        });
    });

    it('never relays an ACK addressed to the server itself', async () => {
        const { other } = await createCluster();

        await other.service.acceptIncomingMessage(
            receiverAck('c', {
                fromPeerId: 'c',
                logicalRecipientPeerId: 'c',
                toPeerId: 'server',
                originPeerId: 'server'
            }),
            'c'
        );

        expect(other.relayed).toEqual([]);
    });

    it('ends the receipt timed out, naming the recipient, when the relay could not be sent', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const owners: ServerInstance[] = [];
        const owner = await createServerInstance({ peerIds: ['a', 'b'], relay: 'none', peers: [] });
        owners.push(owner);
        const other = await createServerInstance({ peerIds: ['c'], relay: 'fails', peers: owners });
        await admitRoomMessage(owner, Date.now() + 400);
        await owner.service.acceptIncomingMessage(receiverAck('b'), 'b');

        expect((await other.service.acceptIncomingMessage(receiverAck('c'), 'c')).right)
            .toEqual({ kind: 'control', handled: false });

        await expect.poll(() => readReceipts(owner.sockets.a!), { timeout: 5_000 }).toEqual([
            { phase: 'admitted', expected: ['b', 'c'], confirmed: [] },
            { phase: 'timed-out', expected: ['b', 'c'], confirmed: ['b'] }
        ]);
    });
});

async function createCluster(): Promise<{ readonly owner: ServerInstance; readonly other: ServerInstance; }> {
    const instances: ServerInstance[] = [];
    const owner = await createServerInstance({
        peerIds: ['a', 'b'],
        relay: 'to-peers',
        peers: instances
    });
    const other = await createServerInstance({
        peerIds: ['c', 'd'],
        relay: 'to-peers',
        peers: instances
    });
    instances.push(owner, other);
    return { owner, other };
}

async function createServerInstance(input: ServerInstanceInput): Promise<ServerInstance> {
    const socket = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of input.peerIds) {
        sockets[peerId] = new SimulatedWebSocket(`ws://${peerId}`);
        await sockets[peerId].open();
        socket.addConnection(new ConnectionContext({ id: peerId, socket: sockets[peerId] }));
    }
    const engine = new InboxOutboxEngine();
    engine.start();
    const relayed: ALMessage[] = [];
    const service = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket,
        name: 'server',
        queueEngine: engine,
        readAuthenticatedConnectionScope: (connection) =>
            socket.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        targetResolver: {
            resolvePeerRecipients: (peerId) => sockets[peerId] === undefined ? [] : [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => input.peerIds.map((peerId) => ({ peerId, connectionId: peerId }))
        },
        publishRelayedAck: toRelayPort(input, relayed)
    });
    service.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? {
                    authorized: true,
                    roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: 7 }
                }
                : { authorized: true }
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
        vi.restoreAllMocks();
    });
    return { service, sockets, relayed };
}

function toRelayPort(
    input: ServerInstanceInput,
    relayed: ALMessage[]
): WsServerAckRelayPublisher | undefined {
    switch (input.relay) {
        case 'none':
            return undefined;
        case 'fails':
            return async (message) => {
                relayed.push(message);
                return Either.ofLeft('notice channel is down');
            };
        case 'to-peers':
            return async (message) => {
                relayed.push(message);
                for (
                    const peer of input.peers.filter((candidate) => candidate.relayed !== relayed)
                ) {
                    await peer.service.acceptRelayedAck(message);
                }
                return Either.ofRight('published');
            };
    }
}

async function admitRoomMessage(owner: ServerInstance, expiresAtMs: number): Promise<void> {
    const message: ALMessage = {
        id: { v: 2, msgId: 'room-message-1', ts: Date.now(), senderId: 'a' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
    expect((await owner.service.acceptIncomingMessage(message, 'a')).right?.kind).toBe('admitted');
    await expect.poll(() => readReceipts(owner.sockets.a!).map((receipt) => receipt.phase)).toEqual(
        ['admitted']
    );
}

function receiverAck(
    recipient: string,
    address: Partial<Pick<ALAckPayload, 'fromPeerId' | 'logicalRecipientPeerId' | 'toPeerId' | 'originPeerId'>> = {}
): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId: 'room-message-1',
            fromPeerId: address.fromPeerId ?? recipient,
            toPeerId: address.toPeerId ?? 'a',
            originPeerId: address.originPeerId ?? 'a',
            logicalRecipientPeerId: address.logicalRecipientPeerId ?? recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function readReceipts(socket: SimulatedWebSocket): readonly Readonly<{
    phase: ALReceiptPayload['phase'];
    expected: readonly string[];
    confirmed: readonly string[];
}>[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)))
        .map((receipt) => ({
            phase: receipt.phase,
            expected: receipt.expectedRecipientPeerIds,
            confirmed: receipt.confirmedRecipientPeerIds
        }));
}
