import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_ACK_TYPE_ID, AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { newALAckControlMessage, type ALAckPayload, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
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
}

interface ReceiptFixtureOptions {
    /** The router's outbox branch: the admitted message leaves through the service's own outbound row. */
    readonly fanout: 'forward' | 'outbox';
}

describe('WS server receipt aggregation for receiver acknowledgements', () => {
    it('admits a receiver ACK addressed to the origin as the aggregating relay hop', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward' });
        await admitRoomMessage(fixture);

        const admitted = await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');

        expect(admitted.left).toBeUndefined();
        expect(admitted.right?.kind).toBe('control');
    });

    it('answers the origin with the admitted audience at once and the complete aggregate as one more row', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward' });
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
        const fixture = await createReceiptFixture({ fanout: 'forward' });
        await admitRoomMessage(fixture);
        await fixture.service.acceptIncomingMessage(receiverAck(fixture, 'b'), 'b');
        // c's ACK landed on another instance (D37): this instance's aggregate never counts it.

        fixture.clock.nowMs += 60_000;
        await fixture.engine.executeOnce();

        // The admitted row expired with the clock; the socket keeps the whole exchange.
        await expect.poll(() => readSentReceipts(fixture.sockets.a).map((receipt) => receipt.phase)).toEqual([
            'admitted',
            'timed-out'
        ]);
        expect(await readReceiptRows(fixture)).toEqual([
            expect.objectContaining({ phase: 'timed-out', expectedRecipientPeerIds: ['b', 'c'], confirmedRecipientPeerIds: ['b'] })
        ]);
        await fixture.engine.executeOnce();
        expect(readSentReceipts(fixture.sockets.a)).toHaveLength(2);
    });

    it('sends the origin no acknowledgement of its own and never re-originates a receiver ACK under the origin name', async () => {
        const fixture = await createReceiptFixture({ fanout: 'forward' });
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

    it('answers an outbox-fanned receiver message with one complete row, not one per aggregator', async () => {
        const fixture = await createReceiptFixture({ fanout: 'outbox' });
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
        expect(aggregation.recordAck(aggregateAck({ fromPeerId: 'b', logicalRecipientPeerId: 'b' })).right).toEqual({ receipt: undefined });
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
        expect(aggregation.aggregatesForOrigin('a')).toBe(false);
        expect(aggregation.sweep(Number.MAX_SAFE_INTEGER)).toEqual([]);
    });
});

function createAggregation(): WsQueueBoxServerReceiptAggregation {
    const aggregation = new WsQueueBoxServerReceiptAggregation({
        serverPeerId: 'server',
        clock: { nowMs: () => 1_000 },
        newControlId: () => 'receipt',
        queueEngine: new InboxOutboxEngine(),
        enqueueOutbox: async (message) => ({ verdict: { kind: 'admitted', durable: false, queuedAttempts: 1 }, message, entries: [] }),
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
            resolveBroadcastRecipients: () => [...server.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }))
        },
        inboundStores: { admissionStore: createTestInboundStore(admission, clock), workQueue: admission.workQueue }
    });
    service.authorizeInboundMessagesWith({
        authorize: async () => ({ authorized: true, groupRecipientPeerIds: ['a', 'b', 'c'], snapshotVersion: SNAPSHOT_VERSION })
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
    return { service, engine, outbox, sockets, clock };
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
    const entries = await Promise.all((await fixture.outbox.getAllKeys()).map((key) => fixture.outbox.getItem(key)));
    return entries
        .flatMap((entry) => entry?.typeId === EnqueuedType.WS_OUTBOX ? [decodePersistedALMessage(entry.resource)] : [])
        .filter((message) => message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
        .sort((left, right) => toPhaseOrder(left) - toPhaseOrder(right))
        .map((message) => decodeALReceiptPayload(JSON.parse(message.payload.resource)));
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
