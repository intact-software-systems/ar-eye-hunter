import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage,
    newALReceiptControlMessage
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { createDefaultWsQueueBoxClientService, type WsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { computeWsQueueBoxServerReceiptRepublishDelayMs } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-row.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';
import { TestWebSocket } from '../websocket/test-web-socket.ts';
import {
    connect,
    createBridgeBus,
    createClusterInstance,
    installClock,
    readSentReceipts,
    roomMessage,
    runReceiptWorkerHandoff,
    type ClusterInstance,
    type ReceiptClock
} from './ws-queue-box-server-receipt-fixture.ts';

const SNAPSHOT_VERSION = 7;
const ROOM_MESSAGE_LIFETIME_MS = 30_000;

interface OriginClient {
    readonly service: WsQueueBoxClientService;
    readonly settlements: ALDeliverySettlement[];
}

interface AdvanceClusterClockInput {
    readonly clock: ReceiptClock;
    readonly instance: ClusterInstance;
    readonly untilMs: number;
    /** Stops early, at the moment the awaited delivery happened. */
    readonly until: () => boolean;
}

interface ReceiptMessageInput {
    readonly observedAtEpochMs: number;
    readonly expiresAtMs: number;
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
        const outboundStores = createDefaultInMemoryALOutboundRuntimeStores({
            nowMs: () => clock.nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), () => clock.nowMs)
        });
        const bus = createBridgeBus();
        const local = await createClusterInstance({ name: 'server', outboundStores, bus, publisherId: 'local', engine: new InboxOutboxEngine() });
        local.engine.start();
        const remote = await createClusterInstance({ name: 'remote-server', outboundStores, bus, publisherId: 'remote', engine: new InboxOutboxEngine() });
        remote.engine.start();
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

    it('delivers the admitted receipt when another server claims its prepared send', async () => {
        const clock = installClock();
        const stores = createDefaultInMemoryALOutboundRuntimeStores({
            nowMs: () => clock.nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => clock.nowMs)
        });
        const result = await runReceiptWorkerHandoff({ storesA: stores, storesB: stores, nowMs: clock.nowMs });

        expect(result.wrongFrames).toEqual([]);
        expect(result.receipts, JSON.stringify(result.claims)).toEqual([expect.objectContaining({
            msgId: 'room-message-1',
            originPeerId: 'a',
            phase: 'admitted',
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: [],
            snapshotVersion: 7
        })]);
    });

    it('publishes a receipt again after as long as it has already waited, and a last time just before it expires', () => {
        const receipt = receiptMessage({ observedAtEpochMs: 100_000, expiresAtMs: 200_000 });

        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 100_000)).toBe(1_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 104_000)).toBe(4_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 150_000)).toBe(30_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 180_000)).toBe(19_000);
        expect(computeWsQueueBoxServerReceiptRepublishDelayMs(receipt, 199_000)).toBe(1_000);
    });
});

/** Moves the clock in half-second steps, giving the instance's work every due turn on the way. */
async function advanceClusterClock(input: AdvanceClusterClockInput): Promise<void> {
    while (input.clock.nowMs < input.untilMs && !input.until()) {
        input.clock.nowMs = Math.min(input.clock.nowMs + 500, input.untilMs);
        for (let pass = 0; pass < 3; pass += 1) {
            await input.instance.engine.executeOnce();
        }
    }
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
        serverPeerId: 'server',
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({ decodePrepared: decodeALOutboundTransportMessage }),
        outboundSettlements: (settlement) => settlements.push(settlement)
    });
    onTestFinished(() => service.close());
    return { service, settlements };
}

async function relayFrames(socket: SimulatedWebSocket, origin: OriginClient): Promise<void> {
    for (const frame of socket.sent) {
        await origin.service.acceptIncomingMessage(JSON.parse(frame));
    }
}

function receiverAck(recipient: 'b' | 'c', nowMs: number): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: `ack-${recipient}`, senderId: recipient, ts: nowMs },
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

function receiptMessage(input: ReceiptMessageInput): ALMessage {
    return {
        ...newALReceiptControlMessage(
            { v: 3, msgId: 'receipt-complete', senderId: 'server', ts: input.observedAtEpochMs },
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
