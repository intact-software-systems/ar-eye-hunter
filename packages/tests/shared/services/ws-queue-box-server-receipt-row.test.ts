import { Temporal } from '@js-temporal/polyfill';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage,
    newALReceiptControlMessage,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { computeWsQueueBoxServerReceiptRepublishDelayMs } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-row.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SNAPSHOT_VERSION = 7;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;

interface ClusterInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly server: JsonWebSocketServer;
}

interface OriginClient {
    readonly service: WsQueueBoxClientService;
    readonly settlements: ALDeliverySettlement[];
}

describe('WS server receipt row across a cluster', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        TestWebSocket.instances.length = 0;
    });

    it.each([
        ['just after the complete receipt was dequeued', 5_000],
        ['at the deadline plus the receipt grace less five seconds', ROOM_MESSAGE_LIFETIME_MS + AL_RECEIPT_DEADLINE_GRACE_MS - 5_000]
    ])('reaches an origin that reconnects on another instance %s, and its handle reads acknowledged', async (_moment, reconnectAfterMs) => {
        const clock = installClock();
        const sentAtMs = clock.nowMs;
        const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
        const bus = createBridgeBus();
        const local = await createClusterInstance({ name: 'server', outbox, bus, publisherId: 'local' });
        const remote = await createClusterInstance({ name: 'remote-server', outbox, bus, publisherId: 'remote' });
        const sockets = { a: await connect(local, 'a'), b: await connect(local, 'b'), c: await connect(local, 'c') };
        const origin = await createOriginClient();
        const message = roomMessage(clock.nowMs);
        expect((await origin.service.enqueueOutboxIfAbsent(message)).verdict.kind).toBe('admitted');

        expect((await local.service.acceptIncomingMessage(message, 'a')).right?.kind).toBe('admitted');
        await expect.poll(() => readSentReceipts(sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);
        await relayFrames(sockets.a, origin);
        await expect.poll(() => readRoomMessageCopies(sockets.c)).toBe(1);

        await sockets.a.receiveClose(1001, 'origin went away');
        await local.service.acceptIncomingMessage(receiverAck('b', clock.nowMs), 'b');
        await local.service.acceptIncomingMessage(receiverAck('c', clock.nowMs), 'c');
        await advanceClusterClock({ clock, instance: local, untilMs: sentAtMs + reconnectAfterMs, until: () => false });
        const reconnected = await connect(remote, 'a');
        await advanceClusterClock({
            clock,
            instance: local,
            untilMs: sentAtMs + ROOM_MESSAGE_LIFETIME_MS + AL_RECEIPT_DEADLINE_GRACE_MS,
            until: () => readSentReceipts(reconnected).some((receipt) => receipt.phase === 'complete')
        });
        await relayFrames(reconnected, origin);

        expect(readSentReceipts(reconnected).map((receipt) => receipt.phase)).toContain('complete');
        expect(origin.settlements.filter((settlement) => settlement.kind === 'acknowledgement').at(-1)).toMatchObject({
            msgId: 'room-message-1',
            mode: 'receiver',
            confirmedHopPeerIds: [],
            unconfirmedHopPeerIds: [],
            confirmedRecipientPeerIds: ['b', 'c'],
            unconfirmedRecipientPeerIds: [],
            complete: true
        });
    });

    it('publishes a receipt again after as long as it has already waited, and a last time just before it expires', () => {
        const receipt = receiptMessage({ observedAtEpochMs: 100_000, expiresAtMs: 200_000 });

        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 100_000)).toBe(1_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 104_000)).toBe(4_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 150_000)).toBe(AL_RECEIPT_DEADLINE_GRACE_MS);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 180_000)).toBe(19_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 199_000)).toBe(1_000);
    });
});

interface AdvanceClusterClockInput {
    readonly clock: { nowMs: number; };
    readonly instance: ClusterInstance;
    readonly untilMs: number;
    /** Stops early, at the moment the awaited delivery happened. */
    readonly until: () => boolean;
}

/** Moves the clock in half-second steps, giving the instance's work every due turn on the way. */
async function advanceClusterClock(input: AdvanceClusterClockInput): Promise<void> {
    while (input.clock.nowMs < input.untilMs && !input.until()) {
        input.clock.nowMs = Math.min(input.clock.nowMs + 500, input.untilMs);
        for (let pass = 0; pass < 3; pass += 1) {
            await input.instance.engine.executeOnce();
        }
    }
}

function installClock(): { nowMs: number; } {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    return clock;
}

interface CreateClusterInstanceInput {
    readonly name: string;
    readonly outbox: InMemoryQueueBox;
    readonly bus: QueueBoxPubSubBridge;
    readonly publisherId: string;
}

/** One server instance of the cluster, fanning room messages out through its own outbox as production does. */
async function createClusterInstance(input: CreateClusterInstanceInput): Promise<ClusterInstance> {
    const server = new JsonWebSocketServer();
    const engine = new InboxOutboxEngine();
    engine.start();
    const openRecipients = () =>
        [...server.connections.values()].filter((connection) => connection.isOpen).map((connection) => ({
            peerId: connection.id,
            connectionId: connection.id
        }));
    const service = createDefaultWsQueueBoxServerService({
        outbox: input.outbox,
        socket: server,
        name: input.name,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        targetResolver: {
            resolvePeerRecipients: (peerId) => openRecipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: openRecipients
        }
    });
    service.authorizeInboundMessagesWith({
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION } }
                : { authorized: true }
    });
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            await service.enqueueOutboxIfAbsent(message);
        }
    });
    onTestFinished(() => {
        service.dispose();
        engine.stop();
    });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: service, bridge: input.bus, channel: 'ws', publisherId: input.publisherId });
    return { service, engine, server };
}

async function connect(instance: ClusterInstance, peerId: string): Promise<SimulatedWebSocket> {
    const socket = new SimulatedWebSocket(`ws://${peerId}-on-${instance.service.name}`);
    await socket.open();
    instance.server.addConnection(new ConnectionContext({ id: peerId, socket }));
    return socket;
}

/** The origin's own WS client: its receipt tracking reads whatever receipt frame reaches its session. */
async function createOriginClient(): Promise<OriginClient> {
    vi.stubGlobal('WebSocket', TestWebSocket);
    const client = new JsonWebSocketClient('ws://configured-server', createPassThroughTransportFaultPort());
    const connected = client.connect();
    await Promise.resolve();
    TestWebSocket.instances.at(-1)!.open();
    await connected;
    const settlements: ALDeliverySettlement[] = [];
    const service = createDefaultWsQueueBoxClientService({
        outbox: new InMemoryQueueBox(new Map()),
        socket: client,
        sessionId: 'a',
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage }),
        outboundSettlements: (settlement) => settlements.push(settlement)
    });
    onTestFinished(() => service.close());
    return { service, settlements };
}

function createBridgeBus(): QueueBoxPubSubBridge {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    return {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
}

async function relayFrames(socket: SimulatedWebSocket, origin: OriginClient): Promise<void> {
    for (const frame of socket.sent) {
        await origin.service.acceptIncomingMessage(JSON.parse(frame));
    }
}

function roomMessage(nowMs: number): ALMessage {
    return {
        id: { v: 2, msgId: 'room-message-1', ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + ROOM_MESSAGE_LIFETIME_MS },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function receiverAck(recipient: 'b' | 'c', nowMs: number): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${recipient}`, senderId: recipient, ts: nowMs },
        {
            ackedMsgId: 'room-message-1',
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: nowMs
        }
    );
}

function receiptMessage(input: Readonly<{ observedAtEpochMs: number; expiresAtMs: number; }>): ALMessage {
    return {
        ...newALReceiptControlMessage(
            { v: 2, msgId: 'receipt-complete', senderId: 'server', ts: input.observedAtEpochMs },
            {
                msgId: 'room-message-1',
                originPeerId: 'a',
                expectedRecipientPeerIds: ['b', 'c'],
                confirmedRecipientPeerIds: ['b', 'c'],
                snapshotVersion: SNAPSHOT_VERSION,
                phase: 'complete',
                observedAtEpochMs: input.observedAtEpochMs
            }
        ),
        constraints: { expiresAtMs: input.expiresAtMs }
    };
}

function readRoomMessageCopies(socket: SimulatedWebSocket): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === 'room-message-1').length;
}

function readSentReceipts(socket: SimulatedWebSocket): readonly ALReceiptPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}
