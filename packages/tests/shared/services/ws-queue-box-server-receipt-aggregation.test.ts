import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { installQueueBoxPubSubBridge } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-bridge.ts';
import type { QueueBoxPubSubBridge, QueueBoxPubSubMessage } from '@shared-server/rallar-system/queue-pubsub/queue-box-pub-sub-contracts.ts';

import { isRoomScopedALMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage,
    type ALAckPayload,
    type ALReceiptPayload
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore, type ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WsQueueBoxServerReceiptAggregation } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';
import { createDefaultWsQueueBoxServerService, type WsQueueBoxServerService } from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const SNAPSHOT_VERSION = 7;

interface ReceiptFixture {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly outbox: InMemoryQueueBox;
    readonly sockets: Readonly<Record<'a' | 'b' | 'c', SimulatedWebSocket>>;
    readonly clock: { nowMs: number; };
    /** The origin's socket on a second instance, when the origin's live session is there. */
    readonly remoteOrigin: SimulatedWebSocket | undefined;
}

interface ReceiptFixtureOptions {
    /** The router's outbox branch: the admitted message leaves through the service's own outbound row. */
    readonly fanout: 'forward' | 'outbox';
    /** `remote`: the origin's live session is on a second instance that shares the outbox. */
    readonly origin: 'local' | 'remote';
}

describe('WS server receipt aggregation for receiver acknowledgements', () => {
    it('admits a receiver ACK addressed to the origin as the aggregating relay hop', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);

        const admitted = await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        expect(admitted.left).toBeUndefined();
        expect(admitted.right?.kind).toBe('control');
    });

    it('refuses at ingress, as its typed return value, a relayed ACK the aggregate cannot count', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        const repeated = await fixture.service.acceptIncomingMessage(
            { ...receiverAck(fixture, 'b'), id: { ...receiverAck(fixture, 'b').id, msgId: 'ack-b-again' } },
            'b'
        );

        expect(repeated.left).toEqual({
            code: 'unauthorized',
            message: 'AL acknowledgement confirms a peer the receipt already counted'
        });
    });

    it('answers the origin with the admitted audience at once and the complete aggregate as one more row', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await expect.poll(() => readReceiptRows(fixture)).toEqual([
            expect.objectContaining({ phase: 'admitted', expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: [] })
        ]);
        expect((await readReceiptRows(fixture))[0]).toMatchObject({
            msgId: 'room-message-1',
            originPeerId: 'a',
            snapshotVersion: SNAPSHOT_VERSION
        });

        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        expect((await readReceiptRows(fixture)).map((receipt) => receipt.phase)).toEqual(['admitted']);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        const receipts = await readReceiptRows(fixture);
        expect(receipts.map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);
        expect(receipts[1]).toMatchObject({
            expectedRecipientPeerIds: ['b', 'c'],
            confirmedRecipientPeerIds: ['b', 'c'],
            snapshotVersion: SNAPSHOT_VERSION
        });
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual([
            'admitted',
            'complete'
        ]);
    });

    it('times the aggregate out at the message deadline, naming a recipient whose ACK this instance never saw', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        // c's ACK landed on another instance (D37): this instance's aggregate never counts it.
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);

        fixture.clock.nowMs += 30_000;
        await fixture.engine.executeOnce();

        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual([
            'admitted',
            'timed-out'
        ]);
        expect((await readReceiptRows(fixture)).filter((receipt) => receipt.phase === 'timed-out')).toEqual([
            expect.objectContaining({ expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b'] })
        ]);
        await fixture.engine.executeOnce();
        expect(readSentReceipts(fixture.sockets.a)).toHaveLength(2);
    });

    it('keeps a complete receipt observed early deliverable until the message deadline plus the receipt grace', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const admittedAtMs = fixture.clock.nowMs;
        await admitRoomMessage(fixture);
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual(['admitted']);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        const complete = (await readReceiptMessages(fixture)).find((message) =>
            decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase === 'complete'
        );
        expect(complete?.constraints?.expiresAtMs).toBe(admittedAtMs + 30_000 + AL_RECEIPT_DEADLINE_GRACE_MS);

        // The row is dispatched one second past the grace counted from the observed complete, as for an origin away that long.
        fixture.clock.nowMs += AL_RECEIPT_DEADLINE_GRACE_MS + 1_000;
        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase);
        }).toEqual(['admitted', 'complete']);
    });

    it('sends the origin no acknowledgement of its own and never re-originates a receiver ACK under the origin name', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');
        await expect.poll(async () => (await readReceiptRows(fixture)).length).toBe(2);
        for (let pass = 0; pass < 4; pass += 1) {
            await fixture.engine.executeOnce();
        }

        const acknowledgementsToOrigin = fixture.sockets.a.sent
            .map((frame) => decodePersistedALMessage(frame))
            .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID);
        expect(acknowledgementsToOrigin).toEqual([]);
    });

    it('acknowledges a receiver unicast addressed to the server as its logical recipient', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'local' });
        const toServer: ALMessage = {
            ...roomMessage(fixture.clock.nowMs),
            id: { v: 2, msgId: 'to-server-1', ts: fixture.clock.nowMs, senderId: 'a' },
            route: { topicId: 'server.command', resourceId: 'resource', contextId: 'server' },
            targets: { mode: 'unicast', toPeerId: 'server' }
        };

        expect((await fixture.service.acceptIncomingMessage(toServer, 'a')).right?.kind).toBe('admitted');

        await expect.poll(() =>
            fixture.sockets.a.sent
                .map((frame) => decodePersistedALMessage(frame))
                .filter((message) => message.payload.typeId === AL_CONTROL_ACK_TYPE_ID)
                .map((message) => JSON.parse(message.payload.resource).logicalRecipientPeerId)
        ).toEqual(['server']);
        expect(readSentReceipts(fixture.sockets.a)).toEqual([]);
    });

    it('reaches an origin whose live session is on another instance with the admitted and the complete receipt', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward', origin: 'remote' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');

        await expect.poll(async () => {
            await fixture.engine.executeOnce();
            return readSentReceipts(fixture.remoteOrigin!).map((receipt) => receipt.phase);
        }).toEqual(['admitted', 'complete']);
        expect(readSentReceipts(fixture.sockets.a)).toEqual([]);
    });

    it('answers an outbox-fanned receiver message with one complete row, not one per aggregator', async () => {
        const fixture = await createReceiptFixture({ fanout: 'outbox', origin: 'local' });
        await admitRoomMessage(fixture);
        await expect.poll(() => fixture.sockets.c.sent.length).toBeGreaterThan(0);

        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'c'), 'c');
        for (let pass = 0; pass < 4; pass += 1) {
            await fixture.engine.executeOnce();
        }

        const receipts = await readReceiptRows(fixture);
        expect(receipts.filter((receipt) => receipt.phase === 'complete')).toHaveLength(1);
        expect(receipts.map((receipt) => receipt.phase)).toEqual(['admitted', 'complete']);
    });
});

describe('WS server receipt aggregate', () => {
    it.each([
        {
            name: 'a recipient outside the frozen audience',
            ack: { fromPeerId: 'd', logicalRecipientPeerId: 'd' },
            reason: 'AL acknowledgement confirms no recipient of the frozen audience'
        },
        {
            name: 'a sender speaking for another recipient',
            ack: { fromPeerId: 'b', logicalRecipientPeerId: 'c' },
            reason: 'AL acknowledgement speaks for another recipient than its sender'
        },
        {
            name: 'another message of the origin',
            ack: { fromPeerId: 'b', logicalRecipientPeerId: 'b', ackedMsgId: 'other-message' },
            reason: 'AL acknowledgement names no receipt this server aggregates'
        }
    ])('refuses $name as a typed rejection that counts nothing', ({ ack, reason }) => {
        const aggregation = createAggregation();
        aggregation.recordAdmission(admission());

        expect(aggregation.recordAck(aggregateAck(ack)).left).toEqual({ code: 'unauthorized', message: reason });
        expect(aggregation.recordAck(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })).right)
            .toEqual({ receipt: undefined, deadlineAtMs: 30_000 });
    });

    it('refuses a repeat ACK for a counted recipient and answers complete exactly once', () => {
        const aggregation = createAggregation();
        aggregation.recordAdmission(admission());
        aggregation.recordAck(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' }));

        expect(aggregation.recordAck(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })).left?.message)
            .toBe('AL acknowledgement confirms a peer the receipt already counted');
        expect(aggregation.recordAck(aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c' })).right?.receipt)
            .toMatchObject({ phase: 'complete', confirmedRecipientPeerIds: ['b', 'c'] });
        expect(aggregation.recordAck(aggregateAck({ fromPeerId: 'c', logicalRecipientPeerId: 'c' })).left?.message)
            .toBe('AL acknowledgement names no receipt this server aggregates');
        expect(aggregation.sweep(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it('answers an empty audience complete at admission and keeps nothing to sweep', () => {
        const aggregation = createAggregation();

        expect(aggregation.recordAdmission({ ...admission(), expectedRecipientPeerIds: [] })).toMatchObject({
            phase: 'admitted',
            expectedRecipientPeerIds: []
        });
        expect(aggregation.readRelayedAckRejection(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' }))?.message)
            .toBe('AL acknowledgement names no receipt this server aggregates');
        expect(aggregation.sweep(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
});

function createAggregation(): WsQueueBoxServerReceiptAggregation {
    const aggregation = new WsQueueBoxServerReceiptAggregation({
        serverPeerId: 'server',
        clock: { nowMs: () => 1_000 },
        newControlId: () => 'receipt',
        qosProvider: undefined,
        queueEngine: new InboxOutboxEngine(),
        enqueueOutbox: async (message) => ({ verdict: { kind: 'admitted', durable: true, queuedAttempts: 0 }, message, entries: [] }),
        acceptServerControl: async () => ({ kind: 'not-handled' })
    });
    onTestFinished(() => aggregation.dispose());
    return aggregation;
}

function admission(): WsQueueBoxServerReceiptAggregation.Admission {
    return {
        msgId: 'room-message-1',
        originPeerId: 'a',
        expectedRecipientPeerIds: ['b', 'c'],
        snapshotVersion: SNAPSHOT_VERSION,
        deadlineAtMs: 30_000
    };
}

function aggregateAck(
    ack: Readonly<{ fromPeerId: string; logicalRecipientPeerId: string; ackedMsgId?: string; }>
): ALAckPayload {
    return {
        ackedMsgId: ack.ackedMsgId ?? 'room-message-1',
        fromPeerId: ack.fromPeerId,
        toPeerId: 'a',
        originPeerId: 'a',
        logicalRecipientPeerId: ack.logicalRecipientPeerId,
        carrier: 'ws',
        status: 'delivered',
        observedAtEpochMs: 1_000
    };
}

async function createReceiptFixture(options: ReceiptFixtureOptions): Promise<ReceiptFixture> {
    const clock = { nowMs: Date.now() };
    vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs);
    vi.spyOn(Temporal.Now, 'instant').mockImplementation(() => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const server = new JsonWebSocketServer();
    const sockets = { a: new SimulatedWebSocket('ws://a'), b: new SimulatedWebSocket('ws://b'), c: new SimulatedWebSocket('ws://c') };
    for (const [peerId, socket] of Object.entries(sockets)) {
        await socket.open();
        server.addConnection(new ConnectionContext({ id: peerId, socket }));
    }
    const engine = new InboxOutboxEngine();
    const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const admission = createInMemoryALAdmissionState(new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs)));
    const service = createDefaultWsQueueBoxServerService({
        outbox,
        socket: server,
        name: 'server',
        queueEngine: engine,
        forwardsRoomScopedMessages: options.fanout === 'forward',
        targetResolver: {
            resolvePeerRecipients: (peerId) => options.origin === 'remote' && peerId === 'a' ? [] : [{ peerId, connectionId: peerId }],
            resolveBroadcastRecipients: () => [...server.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        inboundStores: { admissionStore: createTestInboundStore(admission, clock), workQueue: admission.workQueue }
    });
    const remoteOrigin = options.origin === 'remote' ? await createRemoteOriginInstance(service, outbox) : undefined;
    service.authorizeInboundMessagesWith({
        authorize: async (message) =>
            isRoomScopedALMessage(message)
                ? { authorized: true, roomAudience: { recipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION } }
                : { authorized: true }
    });
    service.onAnyInboxMessageDo('router', {
        onMessage: async (message) => {
            if (options.fanout === 'outbox') {
                await service.enqueueOutboxIfAbsent(message);
            }
        }
    });
    onTestFinished(() => {
        service.dispose();
        vi.restoreAllMocks();
    });
    return { service, engine, outbox, sockets, clock, remoteOrigin };
}

/** A second instance holding the origin's live socket; the two meet only through the shared outbox and the bus. */
async function createRemoteOriginInstance(local: WsQueueBoxServerService, outbox: InMemoryQueueBox): Promise<SimulatedWebSocket> {
    const server = new JsonWebSocketServer();
    const origin = new SimulatedWebSocket('ws://a-on-remote');
    await origin.open();
    server.addConnection(new ConnectionContext({ id: 'a', socket: origin }));
    const remote = createDefaultWsQueueBoxServerService({
        outbox,
        socket: server,
        name: 'remote-server',
        queueEngine: new InboxOutboxEngine(),
        targetResolver: { resolvePeerRecipients: (peerId) => peerId === 'a' ? [{ peerId, connectionId: 'a' }] : [] }
    });
    onTestFinished(() => remote.dispose());
    const subscribers: ((message: QueueBoxPubSubMessage) => Promise<void> | void)[] = [];
    const bus: QueueBoxPubSubBridge = {
        subscribe: async (_channel, subscriber) => {
            subscribers.push(subscriber);
        },
        publish: async (_channel, message) => {
            await Promise.all(subscribers.map(async (subscriber) => await subscriber(message)));
        }
    };
    await installQueueBoxPubSubBridge({ wsQBoxServerService: local, bridge: bus, channel: 'ws', publisherId: 'local' });
    await installQueueBoxPubSubBridge({ wsQBoxServerService: remote, bridge: bus, channel: 'ws', publisherId: 'remote' });
    return origin;
}

function createTestInboundStore(admission: ALAdmissionMemoryState, clock: { nowMs: number; }): ALInboundAdmissionStore {
    const nowMs = () => clock.nowMs;
    return createALInboundAdmissionStore({
        namespace: 'ws-server-receipts',
        nowMs,
        backend: new InMemoryAdmissionBackend(admission, nowMs),
        orderingTrackTtlMs: 300000,
        supersedenceTrackTtlMs: 300000,
        retention: normalizeALRuntimeStoreRetention()
    });
}

async function admitRoomMessage(fixture: ReceiptFixture): Promise<void> {
    const accepted = await fixture.service.acceptIncomingMessage(roomMessage(fixture.clock.nowMs), 'a');
    expect(accepted.right?.kind).toBe('admitted');
    await expect.poll(() => fixture.sockets.b.sent.length).toBeGreaterThan(0);
}

function roomMessage(nowMs: number): ALMessage {
    return {
        id: { v: 2, msgId: 'room-message-1', ts: nowMs, senderId: 'a' },
        route: { topicId: 'room.notification', resourceId: 'resource', contextId: ROOM.groupId },
        targets: { mode: 'broadcast', scope: 'room', groupRef: ROOM },
        constraints: { expiresAtMs: nowMs + 30_000 },
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        payload: { typeId: 'message.v1', contentType: 'application/json', resource: '{}' }
    };
}

function receiverAck(fixture: ReceiptFixture, recipient: 'b' | 'c'): ALMessage {
    return newALAckControlMessage(
        { v: 2, msgId: `ack-${recipient}`, senderId: recipient, ts: fixture.clock.nowMs },
        {
            ackedMsgId: 'room-message-1',
            fromPeerId: recipient,
            toPeerId: 'a',
            originPeerId: 'a',
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: fixture.clock.nowMs
        }
    );
}

/** Every receipt row the service wrote to its outbox, oldest first. */
async function readReceiptRows(fixture: ReceiptFixture): Promise<readonly ALReceiptPayload[]> {
    return (await readReceiptMessages(fixture)).map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

async function readReceiptMessages(fixture: ReceiptFixture): Promise<readonly ALMessage[]> {
    const entries = await Promise.all((await fixture.outbox.getAllKeys()).map((key) => fixture.outbox.getItem(key)));
    return entries
        .flatMap((entry) => entry?.typeId === EnqueuedType.WS_OUTBOX ? [decodePersistedALMessage(entry.resource)] : [])
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .sort((left, right) => toPhaseOrder(left) - toPhaseOrder(right));
}

function readSentReceipts(socket: SimulatedWebSocket): readonly ALReceiptPayload[] {
    return socket.sent
        .map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
}

function toPhaseOrder(message: ALMessage): number {
    const phase = decodeALReceiptPayload(JSON.parse(message.payload.resource)).phase;
    return phase === 'admitted' ? 0 : 1;
}
