import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import {
    createInitialALDeliveryLifecycle,
    type ALDeliverySettlement
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { computeALDeliveryLifecycle } from '@shared/alm/delivery/compute-al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** The ordering-resync scenario gap: far wider than any repair window, so the relay asks for a resync. */
const RESYNC_GAP_SEQ = 300;

interface RelayFixture {
    readonly server: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<'a' | 'b', SimulatedWebSocket>>;
}

interface OriginClient {
    readonly service: WsQueueBoxClientService;
    readonly outboundStores: ALOutboundRuntimeStores<ALOutboundTransportMessage>;
    readonly settlements: ALDeliverySettlement[];
}

describe('a WS relay rejection at the origin (R-S2c-ii-5)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each(
        [
            { ack: 'none', state: 'transport-accepted' },
            { ack: 'receiver', state: 'rejected' }
        ] as const
    )('states the trusted server rejection of the gapped send with ack $ack, naming no server id; it reads $state', async ({ ack, state }) => {
        const fixture = await createRelayFixture();
        const origin = await createOriginClient();
        const first = orderedRoomMessage('ordered-1', 1, ack);
        const gapped = orderedRoomMessage('ordered-gapped', RESYNC_GAP_SEQ, ack);
        for (const message of [first, gapped]) {
            expect((await origin.service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');
            await fixture.server.acceptIncomingMessage(message, 'a');
        }
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentNacks(fixture.sockets.a).length;
        }).toBe(1);

        const nacks = readSentNacks(fixture.sockets.a);
        expect(nacks.map((nack) => nack.payload.typeId)).toEqual([AL_CONTROL_NACK_TYPE_ID]);
        await relayFrames(fixture.sockets.a, origin);

        const rejected = origin.settlements.filter((settlement) => settlement.kind === 'relay-rejected');
        expect(rejected).toEqual([{
            kind: 'relay-rejected',
            msgId: 'ordered-gapped',
            carrier: 'ws',
            atMs: expect.any(Number),
            relayRejection: { relay: 'trusted-server', reason: 'resync-required' },
            detail: 'The server relay refused the message: resync-required.'
        }]);
        expect(JSON.stringify(rejected)).not.toContain('server-1');
        // A send that tracks no receipt is already terminal at transport-accepted: the rejection lands as evidence only.
        const lifecycle = origin.settlements
            .filter((settlement) => settlement.msgId === 'ordered-gapped')
            .reduce(computeALDeliveryLifecycle, toInitialLifecycle('ordered-gapped', ack));
        expect(lifecycle.state).toBe(state);
        expect(lifecycle.evidence.relayRejection).toEqual({ relay: 'trusted-server', reason: 'resync-required' });
    });

    it('never relays a session NACK to the peer it names', async () => {
        const fixture = await createRelayFixture();
        const nack = newALNackControlMessage(
            { v: 2, msgId: 'nack-from-b', senderId: 'b', ts: Date.now() },
            { msgId: 'ordered-gapped', fromPeerId: 'b', toPeerId: 'a', reason: 'resync-required', observedAtEpochMs: Date.now() }
        );

        const admitted = await fixture.server.acceptIncomingMessage(nack, 'b');

        expect(admitted.left).toBeDefined();
        expect(readSentNacks(fixture.sockets.a)).toEqual([]);
    });

    it('states the server refusing a room unicast to a non-member before admission; the receipted handle reads rejected (C3)', async () => {
        const fixture = await createRelayFixture();
        const origin = await createOriginClient();
        const unicast = roomUnicast('unicast-to-outsider', 'outsider');
        expect((await origin.service.enqueueOutboxIfAbsent(unicast)).verdict.kind).toBe('admitted');

        const refused = await fixture.server.acceptIncomingMessage(unicast, 'a');

        expect(refused.left?.code).toBe('unauthorized');
        expect(readSentNacks(fixture.sockets.a)).toHaveLength(1);
        await relayFrames(fixture.sockets.a, origin);
        expect(origin.settlements.filter((settlement) => settlement.kind === 'relay-rejected')).toEqual(
            [{
                kind: 'relay-rejected',
                msgId: 'unicast-to-outsider',
                carrier: 'ws',
                atMs: expect.any(Number),
                relayRejection: { relay: 'trusted-server', reason: 'unauthorized' },
                detail: 'The server refused the message: unauthorized.'
            }]
        );
        const lifecycle = origin.settlements
            .filter((settlement) => settlement.msgId === 'unicast-to-outsider')
            .reduce(computeALDeliveryLifecycle, toInitialLifecycle('unicast-to-outsider', 'receiver'));
        expect(lifecycle.state).toBe('rejected');
        expect(lifecycle.evidence.relayRejection).toEqual({
            relay: 'trusted-server',
            reason: 'unauthorized'
        });
    });

    // Task 1 review forward note: the origin now tracks the server as the hop of a `hop` room unicast (R-S3a-4), but
    // its control admission takes a unicast's NACK from the addressee alone, so the server's refusal is not admitted
    // and the receipt stays open until its retries are spent.
    it('keeps the server hop receipt of a hop room unicast to a non-member open: its refusal NACK is not admitted yet', async () => {
        const fixture = await createRelayFixture();
        const origin = await createOriginClient();
        const unicast: ALMessage = {
            ...roomUnicast('hop-to-outsider', 'outsider'),
            delivery: { reliability: 'at-least-once', ack: 'none' },
            qos: { ack: { algo: 'hop' } }
        };
        expect((await origin.service.enqueueOutboxIfAbsent(unicast)).trackedReceiptAlgo).toBe('hop');

        const refused = await fixture.server.acceptIncomingMessage(unicast, 'a');

        expect(refused.left?.code).toBe('unauthorized');
        expect(readSentNacks(fixture.sockets.a)).toHaveLength(1);
        await relayFrames(fixture.sockets.a, origin);
        expect(
            origin.settlements.filter((settlement) => settlement.kind === 'relay-rejected' || settlement.kind === 'receipt-exhausted')
        ).toEqual([]);
        expect(
            await origin.outboundStores.admissionStore.readReceiptState({
                originPeerId: 'a',
                msgId: 'hop-to-outsider'
            })
        ).toMatchObject({ mode: 'hop', expectedPeerIds: ['server-1'], ackedPeerIds: [] });
    });
});

async function createRelayFixture(): Promise<RelayFixture> {
    const socketServer = new JsonWebSocketServer();
    const sockets = { a: new SimulatedWebSocket('ws://a'), b: new SimulatedWebSocket('ws://b') };
    for (const [peerId, socket] of Object.entries(sockets)) {
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const server = createDefaultWsQueueBoxServerService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: socketServer,
        name: 'server-1',
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    server.authorizeInboundMessagesWith({
        sendNacks: true,
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a', 'b'], snapshotVersion: 3 } }
                : { authorized: true }
    });
    onTestFinished(() => server.dispose());
    return { server, engine, sockets };
}

/** The origin WS client: every frame it reads came from its server, the only source it has. */
async function createOriginClient(): Promise<OriginClient> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const settlements: ALDeliverySettlement[] = [];
    const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage });
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId: 'a',
        serverPeerId: 'server-1',
        outboundStores,
        outboundSettlements: (settlement) => settlements.push(settlement)
    });
    onTestFinished(() => service.close());
    return { service, outboundStores, settlements };
}

async function relayFrames(socket: SimulatedWebSocket, origin: OriginClient): Promise<void> {
    for (const frame of socket.sent) {
        await origin.service.acceptIncomingMessage(JSON.parse(frame));
    }
}

/** The ordering-resync send: a retained room broadcast on one ordering key, with or without a receipt. */
function orderedRoomMessage(msgId: string, seq: number, ack: 'none' | 'receiver'): ALMessage {
    return {
        id: { v: 2, msgId, ts: Date.now(), senderId: 'a' },
        route: { topicId: 'room.ordered', resourceId: msgId, contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        ordering: { orderingKey: 'resync', epoch: 0, seq },
        delivery: { reliability: 'at-least-once', ack },
        payload: { typeId: 'ordered.v1', contentType: 'application/json', resource: '{}' }
    };
}

/** A receipted command to one session of the room, which names its room so the room's authority admits it. */
function roomUnicast(msgId: string, toPeerId: string): ALMessage {
    return {
        id: { v: 2, msgId, ts: Date.now(), senderId: 'a' },
        route: { topicId: 'room.command', resourceId: msgId, contextId: ROOM.groupId },
        targets: { mode: 'unicast', toPeerId, groupRef: ROOM },
        constraints: { expiresAtMs: Date.now() + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'command.v1', contentType: 'application/json', resource: '{}' }
    };
}

function toInitialLifecycle(msgId: string, ackMode: 'none' | 'receiver') {
    return createInitialALDeliveryLifecycle({
        msgId,
        typeId: 'ordered.v1',
        ackMode,
        receiptAlgo: ackMode,
        expiresAtMs: undefined,
        submittedAtMs: 0
    });
}

function readSentNacks(socket: SimulatedWebSocket): readonly ALMessage[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_NACK_TYPE_ID);
}
