import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    type ALAckPayload,
    type ALNackReason
} from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALSeqRange } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { createDefaultInMemoryALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import {
    createDefaultWsQueueBoxServerService,
    type WsQueueBoxServerService
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-service.ts';
import { ConnectionContext, JsonWebSocketServer } from '@shared/websocket/json-web-socket-server.ts';

import { SimulatedWebSocket } from '../native-websocket-fixture.ts';

const SERVER_ID = 'server';
const SCOPE = { applicationId: 'app', workspaceId: 'workspace' };
const ROOM = { ...SCOPE, groupId: 'room-1' };
const EVENT_TTL_MS = 60_000;
/** The `at-least-once` receipt window: past it, a receipt still pending retries its unconfirmed peers. */
const ACK_TIMEOUT_MS = 2_000;
const CLOCK_STEP_MS = 250;
const ORDERING = { orderingKey: 'game-1', epoch: 1 };
const TRACK_KEY = 'game-1:server:1';
/** Client `a`'s track on the same key, which the server relays. */
const A_TRACK_KEY = 'game-1:a:1';
/** `a` and `b` were in the room when the events were published; `c` joined afterwards. */
const ADMITTED_AUDIENCE = ['a', 'b'];
/** A retransmit's attempt id names the repair hint that asked for it: requester `b`, then the hint's ranges. */
const REPAIR_ATTEMPT_HINT = /:repair-hint:[^:]+:b:[^:]+:([0-9,-]+):/;

type ControlAdmission = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'control-admission'; }>;

interface OrderedServer {
    readonly service: WsQueueBoxServerService;
    readonly engine: InboxOutboxEngine;
    readonly sockets: Readonly<Record<string, SimulatedWebSocket>>;
    readonly clock: { nowMs: number; };
    readonly controlAdmissions: ControlAdmission[];
    readonly settlements: ALDeliverySettlement[];
    /** Every ACK the receipt path counted or refused, the server's own included. */
    readonly countedAcks: ALAckPayload[];
}

interface NackInput {
    readonly fromPeerId: string;
    readonly msgId: string;
    readonly reason: ALNackReason;
    readonly missingRanges: readonly ALSeqRange[];
    /** The origin of the track the NACK names; the server unless named. */
    readonly toPeerId?: string;
    readonly trackKey?: string;
}

/** The retransmits one repair hint produced, in the order they were sent. */
interface RepairPage {
    readonly hint: string;
    readonly seqs: readonly number[];
}

describe('the WS server repairs its own ordered publication', () => {
    it('sequences its keyed publications 1, 2, 3 for the audience it admitted them to', async () => {
        const server = await createOrderedServer();

        const minted = await publishEvents(server, 3);

        expect(minted).toEqual([1, 2, 3].map((seq) => ({ ...ORDERING, seq })));
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.c)).toEqual([]);
    });

    it('admits a gap NACK from a peer the receipt expects and retransmits the missing sequence to that requester alone', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.b))).toEqual([1, 2, 3, 2]);
        await settle(server);
        expect(server.controlAdmissions).toEqual([
            expect.objectContaining({ targetMsgId: 'event-3', outcome: 'committed', reason: 'none' })
        ]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.c)).toEqual([]);
    });

    it('serves a gap wider than one repair page in two ascending pages, to the requester alone', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 35);
        for (let index = 1; index <= 35; index += 1) {
            await receiveAck(server, `event-${index}`, 'a');
        }

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-35', reason: 'gap', missingRanges: [{ from: 1, to: 34 }] });

        // The readiness probe and the claim read `AL_OUTBOUND_WORK_PAGE_SIZE` (16) rows per status in key order. The
        // thirty-five receipts still waiting on `b` sit ahead of the repair rows, and a page of receipts not yet due
        // hides every row behind it, so the clock moves in the poll: each step lets a page of receipts fall due past
        // its ACK timeout, and more than one pass goes through them before the repair rows are reached.
        await expect.poll(async () => {
            server.clock.nowMs += CLOCK_STEP_MS;
            return await runEngine(server, () => readRepairPages(server).flatMap((page) => page.seqs).length);
        }, { timeout: 5_000 }).toBe(34);
        expect(readRepairPages(server)).toEqual([
            { hint: '1-34', seqs: toSeqs(1, 32) },
            { hint: '33-34', seqs: [33, 34] }
        ]);
        expect(readSeqs(server.sockets.b).slice(35, 35 + 34)).toEqual(toSeqs(1, 34));
        expect(readSeqs(server.sockets.a)).toEqual(toSeqs(1, 35));
    });

    it('serves the second requester of a spent sequence from the receipt retry, not from ranged repair', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3, ['a', 'b', 'c']);
        for (const msgId of ['event-1', 'event-2', 'event-3']) {
            await receiveAck(server, msgId, 'a');
        }
        await receiveAck(server, 'event-1', 'b');
        await receiveAck(server, 'event-1', 'c');

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });
        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.b))).toEqual([1, 2, 3, 2]);
        await receiveAck(server, 'event-2', 'b');
        await receiveAck(server, 'event-3', 'b');
        await receiveNack(server, { fromPeerId: 'c', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => readRepairExhaustedMsgIds(server))).toEqual(['event-2']);
        await receiveAck(server, 'event-3', 'c');
        await settle(server);
        expect(readSeqs(server.sockets.c)).toEqual([1, 2, 3]);

        server.clock.nowMs += ACK_TIMEOUT_MS + CLOCK_STEP_MS;
        await expect.poll(() => runEngine(server, () => readMsgIds(server.sockets.c))).toEqual([
            'event-1',
            'event-2',
            'event-3',
            'event-2'
        ]);
        await settle(server);
        expect(readSeqs(server.sockets.c)).toEqual([1, 2, 3, 2]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3, 2]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
        expect(readRepairExhaustedMsgIds(server)).toEqual(['event-2']);
        expect(readRepairPages(server)).toEqual([{ hint: '2-2', seqs: [2] }]);
    });

    it('retransmits nothing for a gap NACK that arrives after the message deadline', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);
        server.clock.nowMs += EVENT_TTL_MS;

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }] });

        await expect.poll(() => runEngine(server, () => server.controlAdmissions)).toEqual([
            expect.objectContaining({ targetMsgId: 'event-3', outcome: 'not-handled' })
        ]);
        await settle(server);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3]);
    });

    it('sends a session admitted from event 4 that event with its own entry and nothing below it', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);

        await publishEvent(server, roundEvent('event-4'), ['a', 'b', 'c']);
        await settle(server);

        expect(readFrames(server.sockets.c, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { c: 0 } }, proof: undefined }]);
        expect(readMsgIds(server.sockets.c)).toEqual(['event-4']);
        expect(readFrames(server.sockets.b, 'event-4')).toEqual([{ ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3, 4]);
    });

    it('resends an unconfirmed copy on the receipt retry with the entry its first dequeue fixed', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 2);
        await publishEvent(server, roundEvent('event-3'), ['a']);
        await publishEvent(server, roundEvent('event-4'), ['a', 'b']);
        for (const msgId of ['event-1', 'event-2', 'event-3', 'event-4']) {
            await receiveAck(server, msgId, 'a');
        }
        await receiveAck(server, 'event-1', 'b');
        await receiveAck(server, 'event-2', 'b');

        server.clock.nowMs += ACK_TIMEOUT_MS + CLOCK_STEP_MS;

        // `b` already stands at 4 when the retry runs: a copy at its position is a retry, not an exclusion.
        await expect.poll(() => runEngine(server, () => readFrames(server.sockets.b, 'event-4').length)).toBe(2);
        expect(readFrames(server.sockets.b, 'event-4')).toEqual([
            { ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { b: 2 } }, proof: undefined },
            { ordering: { ...ORDERING, seq: 4, priorSeqByRecipient: { b: 2 } }, proof: undefined }
        ]);
    });

    it('skips a recipient a later row of its track already reached, and never moves it back', async () => {
        const server = await createOrderedServer();
        await publishEvent(server, browserEvent(2), ['b']);

        await publishEvent(server, browserEvent(1), ['b', 'c'], ['c']);
        await settle(server);

        expect(readFrames(server.sockets.b, 'a-event-1')).toEqual([]);
        expect(server.settlements).toContainEqual(expect.objectContaining({ kind: 'attempt-settled', msgId: 'a-event-1', outcome: 'no-targets' }));
        // The server's own word on the receipt path: it sent `b` nothing, which places `b` outside the audience.
        expect(server.countedAcks).toContainEqual(expect.objectContaining({
            ackedMsgId: 'a-event-1',
            fromPeerId: SERVER_ID,
            toPeerId: 'a',
            logicalRecipientPeerId: 'b',
            status: 'subtree-complete-not-subscribed'
        }));
        expect(readFrames(server.sockets.c, 'a-event-1')).toEqual([{ ordering: { ...ORDERING, seq: 1, priorSeqByRecipient: {} }, proof: undefined }]);

        await publishEvent(server, browserEvent(3), ['b', 'c']);

        expect(readFrames(server.sockets.b, 'a-event-3')).toEqual([{ ordering: { ...ORDERING, seq: 3, priorSeqByRecipient: {} }, proof: undefined }]);
        expect(readFrames(server.sockets.c, 'a-event-3')).toEqual([{ ordering: { ...ORDERING, seq: 3, priorSeqByRecipient: { c: 1 } }, proof: undefined }]);
    });

    it('sends a handed-over signed frame with the server own entry for each recipient and no proof', async () => {
        const server = await createOrderedServer();
        const event = browserEvent(2);
        const handedOver: ALMessage = {
            ...event,
            targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds: ['b', 'c'], snapshotVersion: 1 },
            ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { c: 0 } },
            proof: { alg: 'ES256', keyId: 'K'.repeat(42) + 'A', signature: 'S'.repeat(85) + 'A' }
        };

        await publishEvent(server, handedOver, ['b', 'c']);

        expect(readFrames(server.sockets.b, 'a-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { b: 0 } }, proof: undefined }]);
        expect(readFrames(server.sockets.c, 'a-event-2')).toEqual([{ ordering: { ...ORDERING, seq: 2, priorSeqByRecipient: { c: 0 } }, proof: undefined }]);
    });

    it('serves the gap NACK a session of the admitted audience sends the origin of a relayed track, and refuses one outside it', async () => {
        const server = await createOrderedServer();
        for (const seq of [1, 2, 3]) {
            await publishEvent(server, browserEvent(seq), ['b']);
        }
        const gap = { msgId: 'a-event-3', reason: 'gap', missingRanges: [{ from: 2, to: 2 }], toPeerId: 'a', trackKey: A_TRACK_KEY } as const;

        const served = await server.service.acceptIncomingMessage(toNack(server, { ...gap, fromPeerId: 'b' }), 'b');
        const refused = await server.service.acceptIncomingMessage(toNack(server, { ...gap, fromPeerId: 'c' }), 'c');

        expect(served.left).toBeUndefined();
        expect(refused.left).toEqual({ code: 'unauthorized', message: 'AL repair request names no relayed message admitted to its sender' });
        await expect.poll(() => runEngine(server, () => readMsgIds(server.sockets.b))).toEqual(['a-event-1', 'a-event-2', 'a-event-3', 'a-event-2']);
        await settle(server);
        expect(readMsgIds(server.sockets.c)).toEqual([]);
    });

    it('ends the whole receipt of a message one receiver NACKs resync-required, so no recipient is retried', async () => {
        const server = await createOrderedServer();
        await publishEvents(server, 3);

        await receiveNack(server, { fromPeerId: 'b', msgId: 'event-3', reason: 'resync-required', missingRanges: [] });
        await expect.poll(() => runEngine(server, () => server.settlements)).toContainEqual(expect.objectContaining({
            kind: 'relay-rejected',
            msgId: 'event-3',
            relayRejection: { relay: 'peer', peerId: 'b', reason: 'resync-required' }
        }));
        server.clock.nowMs += ACK_TIMEOUT_MS;

        await expect.poll(() => runEngine(server, () => readSeqs(server.sockets.a))).toEqual([1, 2, 3, 1, 2]);
        await settle(server);
        expect(readSeqs(server.sockets.a)).toEqual([1, 2, 3, 1, 2]);
        expect(readSeqs(server.sockets.b)).toEqual([1, 2, 3, 1, 2]);
        expect(server.settlements).not.toContainEqual(expect.objectContaining({ kind: 'receipt-exhausted', msgId: 'event-3' }));
    });
});

/** One instance whose clock moves only when a test moves it, so no receipt window passes unasked. */
async function createOrderedServer(): Promise<OrderedServer> {
    const clock = mockClock();
    const nowMs = () => clock.nowMs;
    const outbox = new InMemoryQueueBox(new Map(), () => Temporal.Instant.fromEpochMilliseconds(clock.nowMs));
    const socketServer = new JsonWebSocketServer();
    const sockets: Record<string, SimulatedWebSocket> = {};
    for (const peerId of ['a', 'b', 'c']) {
        const socket = new SimulatedWebSocket(`ws://${peerId}`);
        await socket.open();
        socketServer.addConnection(new ConnectionContext({ id: peerId, socket }));
        sockets[peerId] = socket;
    }
    const recipients = () => [...socketServer.connections.keys()].map((peerId) => ({ peerId, connectionId: peerId }));
    const controlAdmissions: ControlAdmission[] = [];
    const settlements: ALDeliverySettlement[] = [];
    const countedAcks: ALAckPayload[] = [];
    const engine = new InboxOutboxEngine();
    const service = createDefaultWsQueueBoxServerService({
        inboundVolatileStores: undefined,
        outbox,
        socket: socketServer,
        name: SERVER_ID,
        queueEngine: engine,
        forwardsRoomScopedMessages: false,
        readAuthenticatedConnectionScope: (connection) =>
            socketServer.connections.get(connection.id) === connection
                ? { scope: SCOPE, expiresAtEpochMs: Number.MAX_SAFE_INTEGER }
                : undefined,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            nowMs,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            outboundBackend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(outbox), nowMs)
        }),
        outboundDiagnostics: (event) => {
            if (event.kind === 'control-admission') {
                controlAdmissions.push(event);
            }
        },
        outboundSettlements: (settlement) => settlements.push(settlement),
        receiptObserver: (observation) => {
            if (observation.kind === 'ack-count') {
                countedAcks.push(observation.ack);
            }
        },
        targetResolver: {
            requiresFrozenAudience: () => false,
            resolvePeerRecipients: (peerId) => recipients().filter((recipient) => recipient.peerId === peerId),
            resolveGroupRecipients: recipients,
            resolveBroadcastRecipients: recipients
        }
    });
    onTestFinished(() => service.dispose());
    return { service, engine, sockets, clock, controlAdmissions, settlements, countedAcks };
}

/** Publishes `event-1` .. `event-<count>` on one track and returns the ordering each was admitted with. */
async function publishEvents(
    server: OrderedServer,
    count: number,
    audience: readonly string[] = ADMITTED_AUDIENCE
): Promise<readonly ALMessage['ordering'][]> {
    const minted: ALMessage['ordering'][] = [];
    for (let index = 1; index <= count; index += 1) {
        minted.push(await publishEvent(server, roundEvent(`event-${index}`), audience));
    }
    return minted;
}

/**
 * Admits one row to the audience and waits until it reached every recipient it sends: rows of a track that record
 * positions commit one after another, and the frozen clock keeps the receipts' timeouts ahead of their sends.
 */
async function publishEvent(
    server: OrderedServer,
    message: ALMessage,
    audience: readonly string[],
    recipients: readonly string[] = audience
): Promise<ALMessage['ordering']> {
    const result = await server.service.enqueueOutboxIfAbsent(
        message,
        { admittedAudience: audience, admittedConnectionGenerationIds: undefined, recipientScope: undefined }
    );
    await expect.poll(
        () => runEngine(server, () => recipients.every((peerId) => readMsgIds(server.sockets[peerId]!).includes(message.id.msgId))),
        { interval: 5 }
    ).toBe(true);
    return result.message.ordering;
}

/** Client `a`'s keyed room event at the sequence `a` stated, as the server relays it. */
function browserEvent(seq: number): ALMessage {
    const msgId = `a-event-${seq}`;
    const message = newALBroadcastMessage(
        'a',
        newALRoute('room.round.event', ROOM.groupId, msgId),
        'room',
        'round.event.v1',
        { msgId },
        { groupRef: ROOM, reliability: 'at-least-once', ack: 'receiver', ttlMs: EVENT_TTL_MS, ordering: { ...ORDERING, seq } }
    );
    return { ...message, id: { ...message.id, msgId } };
}

function roundEvent(msgId: string): ALMessage {
    const message = newALBroadcastMessage(
        SERVER_ID,
        newALRoute('room.round.event', ROOM.groupId, msgId),
        'room',
        'round.event.v1',
        { msgId },
        { groupRef: ROOM, reliability: 'at-least-once', ack: 'receiver', ttlMs: EVENT_TTL_MS, ordering: ORDERING }
    );
    return { ...message, id: { ...message.id, msgId } };
}

/** The receiver's NACK as its WS client sends it: addressed to the server, naming the server's track. */
async function receiveNack(server: OrderedServer, input: NackInput): Promise<void> {
    await server.sockets[input.fromPeerId]!.receive(JSON.stringify(toNack(server, input)));
}

function toNack(server: OrderedServer, input: NackInput): ALMessage {
    return newALNackControlMessage(
        {
            v: 4,
            msgId: `nack-${input.msgId}-${input.fromPeerId}`,
            senderId: input.fromPeerId,
            ts: server.clock.nowMs,
            traceId: 'trace-ws-queue-box-server-ordered-repair'
        },
        {
            msgId: input.msgId,
            fromPeerId: input.fromPeerId,
            logicalRecipientPeerId: input.fromPeerId,
            toPeerId: input.toPeerId ?? SERVER_ID,
            reason: input.reason,
            observedAtEpochMs: server.clock.nowMs,
            ...(input.missingRanges.length === 0 ? {} : {
                orderingKey: input.trackKey ?? TRACK_KEY,
                expectedSeq: input.missingRanges[0]!.from,
                missingRanges: input.missingRanges
            })
        }
    );
}

/** The frames of the track a socket received, as sent: each copy's ordering and proof. */
function readFrames(socket: SimulatedWebSocket, msgId: string): readonly Pick<ALMessage, 'ordering' | 'proof'>[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.id.msgId === msgId)
        .map((message) => ({ ordering: message.ordering, proof: message.proof }));
}

async function receiveAck(server: OrderedServer, ackedMsgId: string, recipient: string): Promise<void> {
    const ack = newALAckControlMessage(
        { v: 4, msgId: `ack-${ackedMsgId}-${recipient}`, senderId: recipient, ts: server.clock.nowMs, traceId: 'trace-ws-queue-box-server-ordered-repair' },
        {
            ackedMsgId,
            fromPeerId: recipient,
            toPeerId: SERVER_ID,
            originPeerId: SERVER_ID,
            logicalRecipientPeerId: recipient,
            carrier: 'ws',
            status: 'delivered',
            observedAtEpochMs: server.clock.nowMs
        }
    );
    await server.sockets[recipient]!.receive(JSON.stringify(ack));
}

/** One engine pass, then the observation: the poll that calls it waits for the server's asynchronous sends. */
async function runEngine<T>(server: OrderedServer, observe: () => T): Promise<T> {
    await server.engine.executeOnce();
    return observe();
}

/** Further passes after the awaited outcome, so a send that should not happen has had its chance to. */
async function settle(server: OrderedServer): Promise<void> {
    for (let pass = 0; pass < 5; pass += 1) {
        await server.engine.executeOnce();
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function readSeqs(socket: SimulatedWebSocket): readonly (number | undefined)[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.ordering?.orderingKey === ORDERING.orderingKey)
        .map((message) => message.ordering?.seq);
}

function readMsgIds(socket: SimulatedWebSocket): readonly string[] {
    return socket.sent.map((frame) => decodePersistedALMessage(frame))
        .filter((message) => message.ordering?.orderingKey === ORDERING.orderingKey)
        .map((message) => message.id.msgId);
}

/** The messages whose repair budget a requester found spent; each is stated once. */
function readRepairExhaustedMsgIds(server: OrderedServer): readonly string[] {
    return server.settlements
        .filter((settlement) =>
            settlement.kind === 'admission' && settlement.verdict.kind === 'skipped' &&
            settlement.verdict.reason === 'repair-exhausted'
        )
        .map((settlement) => settlement.msgId);
}

/** The sent retransmits grouped by the repair hint that asked for them, in the order they were sent. */
function readRepairPages(server: OrderedServer): readonly RepairPage[] {
    const pages: RepairPage[] = [];
    for (const settlement of server.settlements) {
        const hint = settlement.kind === 'attempt-settled' && settlement.outcome === 'sent'
            ? REPAIR_ATTEMPT_HINT.exec(decodeURIComponent(settlement.attemptId))?.[1]
            : undefined;
        if (hint === undefined) {
            continue;
        }
        const seq = Number(settlement.msgId.replace('event-', ''));
        const last = pages.at(-1);
        if (last?.hint === hint) {
            pages[pages.length - 1] = { hint, seqs: [...last.seqs, seq] };
        }
        else {
            pages.push({ hint, seqs: [seq] });
        }
    }
    return pages;
}

function toSeqs(from: number, to: number): readonly number[] {
    return Array.from({ length: to - from + 1 }, (_, index) => from + index);
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
