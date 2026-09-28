import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
    createRallarAlmReceiptDiagnosticsRecorder,
    type RallarAlmReceiptDiagnosticsRecorder
} from '@shared-server/rallar-system/observability/alm-receipt-diagnostics.ts';
import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type {
    QueueBoxPubSubBridge,
    QueueBoxPubSubMessage
} from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';
import {
    newALBroadcastMessage,
    newALRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
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
/** Long enough that the receipt budget (four 2 s windows) ends first. */
const NOTIFICATION_TTL_MS = 60_000;
const CLOCK_STEP_MS = 1_000;

interface ServerInstance {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
}

describe('receipts of the server\'s own room notifications (D58, D61)', () => {
    it('sends only to the audience frozen at publish and records who confirmed, then that the rest never did', async () => {
        const clock = mockClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createOutbox(clock);
        const local = await createInstance({
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        const enqueued = await local.service.enqueueOutboxIfAbsent(
            serverNotification('snapshot-1'),
            ['a', 'b']
        );

        expect(enqueued.verdict.kind).toBe('admitted');
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-1'),
                countCopies(local.sockets.b, 'snapshot-1')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.c, 'snapshot-1')).toBe(0);

        await local.service.acceptIncomingMessage(sessionAck('snapshot-1', 'a'), 'a');
        expect(recorder.readDiagnostics().messages).toEqual([expect.objectContaining({
            msgId: 'snapshot-1',
            mode: 'receiver',
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            receiptExhausted: false
        })]);

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b'],
            lastSettlementKind: 'receipt-exhausted'
        });
    });

    it('keeps a session that left in the receipt, where it reads unconfirmed, while the retries reach the rest (D43)', async () => {
        const clock = mockClock();
        const recorder = createRallarAlmReceiptDiagnosticsRecorder({
            nowEpochMs: () => clock.nowMs,
            capacity: 256
        });
        const outbox = createOutbox(clock);
        const local = await createInstance({
            outbox,
            state: createInMemoryALAdmissionState(outbox),
            peerIds: ['a', 'b', 'c'],
            recorder,
            nowMs: () => clock.nowMs
        });

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-3'), ['a', 'b', 'c']);
        await expect.poll(async () => {
            await local.engine.executeOnce();
            return ['a', 'b', 'c'].map((peerId) => countCopies(local.sockets[peerId], 'snapshot-3'));
        }).toEqual([1, 1, 1]);
        await local.sockets.c.receiveClose(1000, 'left');
        await local.service.acceptIncomingMessage(sessionAck('snapshot-3', 'a'), 'a');

        await expect.poll(async () => {
            clock.nowMs += CLOCK_STEP_MS;
            await local.engine.executeOnce();
            return recorder.readDiagnostics().messages[0]?.receiptExhausted;
        }, { timeout: 5_000 }).toBe(true);
        expect(countCopies(local.sockets.b, 'snapshot-3')).toBeGreaterThan(1);
        expect(recorder.readDiagnostics().messages[0]).toMatchObject({
            confirmedPeerIds: ['a'],
            unconfirmedPeerIds: ['b', 'c']
        });
    });

    it('sends the frozen audience only, on the publishing instance and on every other one (C9)', async () => {
        const clock = mockClock();
        const outbox = createOutbox(clock);
        const state = createInMemoryALAdmissionState(outbox);
        const nowMs = () => clock.nowMs;
        const local = await createInstance({
            outbox,
            state,
            peerIds: ['a', 'b'],
            recorder: undefined,
            nowMs
        });
        const remote = await createInstance({
            outbox,
            state,
            peerIds: ['c', 'd'],
            recorder: undefined,
            nowMs
        });
        await joinCluster(local, remote);

        await local.service.enqueueOutboxIfAbsent(serverNotification('snapshot-2'), ['a', 'c']);

        await expect.poll(async () => {
            await local.engine.executeOnce();
            return [
                countCopies(local.sockets.a, 'snapshot-2'),
                countCopies(remote.sockets.c, 'snapshot-2')
            ];
        }).toEqual([1, 1]);
        expect(countCopies(local.sockets.b, 'snapshot-2')).toBe(0);
        expect(countCopies(remote.sockets.d, 'snapshot-2')).toBe(0);
    });
});

interface CreateInstanceInput {
    readonly outbox: InMemoryQueueBox;
    readonly state: ALAdmissionMemoryState;
    readonly peerIds: readonly string[];
    readonly recorder: RallarAlmReceiptDiagnosticsRecorder | undefined;
    readonly nowMs: () => number;
}

/** One WS server instance; two of them share the outbox and the outbound admission state, as PostgreSQL does. */
async function createInstance(input: CreateInstanceInput): Promise<ServerInstance> {
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of input.peerIds) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        outbox: input.outbox,
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs: input.nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(input.state, input.nowMs)
        }),
        outboundSettlements: input.recorder?.settlements,
        targetResolver: {
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets };
}

async function joinCluster(local: ServerInstance, remote: ServerInstance): Promise<void> {
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    const bus: QueueBoxPubSubBridge = {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: local.service,
        bridge: bus,
        channel: 'ws',
        publisherId: 'local'
    });
    await installQueueBoxPubSubBridge({
        wsQBoxServerService: remote.service,
        bridge: bus,
        channel: 'ws',
        publisherId: 'remote'
    });
}

function mockClock(): { nowMs: number; } {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    onTestFinished(() => {
        vi.restoreAllMocks();
    });
    return clock;
}

function createOutbox(clock: { nowMs: number; }): InMemoryQueueBox {
    return new InMemoryQueueBox(
        new Map(),
        () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)
    );
}

function serverNotification(msgId: string): ALMessage {
    const message = newALBroadcastMessage(
        SERVER_ID,
        newALRoute('room.snapshot', ROOM.groupId, msgId),
        'room',
        'snapshot.v1',
        { msgId },
        {
            groupRef: ROOM,
            reliability: 'at-least-once',
            ack: 'receiver',
            ttlMs: NOTIFICATION_TTL_MS
        }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function sessionAck(ackedMsgId: string, recipient: string): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: Date.now() },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: SERVER_ID,
            originPeerId: SERVER_ID,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}

function countCopies(socket: SimulatedWebSocket, msgId: string): number {
    return socket.sent.filter((frame) => decodePersistedALMessage(frame).id.msgId === msgId).length;
}
