import { appendFileSync } from 'node:fs';
import { loadavg } from 'node:os';

import { expect, it } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { createPSqlCounterScope } from '@shared-server/postgres/create-p-sql-counter-scope.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { EDGE_ORDER_RECEIVER_DEFAULT_LIMITS } from '@shared-web/browser/messages/edge-order/edge-order-receiver-limits.ts';
import { EDGE_ORDER_ACKNOWLEDGED_SETTLE_MS, EdgeOrderSender } from '@shared-web/browser/messages/edge-order/edge-order-sender.ts';
import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import { decodeEdgeOrderWirePayload, toEdgeOrderWireJson } from '@shared-web/browser/messages/edge-order/edge-order-wire-payload.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID, isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { computeUtf8ByteLength } from '@shared/encoding/compute-utf8-byte-length.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

import { createDelayedPSqlSql } from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/instance/create-delayed-p-sql-sql.ts';
import type { SimulatedWebSocket } from '../../../../shared/native-websocket-fixture.ts';
import {
    connect,
    createClusterInstance,
    RECEIPT_SERVER_PEER_ID,
    receiverAck,
    roomMessage,
    type ClusterInstance
} from '../../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import { createRuntimeStatePostgresSql, requirePostgresDatabaseUrl } from '../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createReceiptCluster, type ReceiptCluster } from '../test-support/create-receipt-cluster.ts';
import {
    computeEdgeOrderFigures,
    summarizeEdgeOrderValues,
    type EdgeOrderFigures,
    type EdgeOrderSummary
} from './compute-edge-order-figures.ts';
import type { EdgeOrderArrival } from './replay-edge-order-arrivals.ts';

// The edge-order measurement: do UNORDERED receipted room sends, each stamped by the browser's edge-order sender and
// sorted by the browser's edge-order receiver, keep up through three WS server instances on PostgreSQL? Evidence, not
// a gate: it loads the machine for about half an hour, and its figures are only comparable between runs on one quiet
// machine. See `tests/manual-suites.json` for the command.

/** One cell: who publishes, how often each of them sends, and how many messages each sends. */
interface MeasuredCell {
    readonly name: string;
    readonly publishers: readonly string[];
    readonly intervalMs: number;
    readonly messagesPerPublisher: number;
}

/** A sent room message, and what its publisher's socket and its recipients' sockets were sent about it. */
interface SentMessage {
    readonly msgId: string;
    readonly publisher: string;
    readonly stamp: EdgeOrderStamp;
    /** The payload as it was sent: the stamp beside an empty application payload. */
    readonly resource: string;
    readonly recipients: readonly string[];
    readonly sentAt: number;
    readonly expiresAtEpochMs: number;
    readonly readBy: Set<string>;
    acceptance: string | undefined;
    admittedAt: number | undefined;
    terminalAt: number | undefined;
    terminalPhase: string | undefined;
    lastAckOfferedAt: number | undefined;
}

/** What would make a run's figures wrong, counted so the run can refuse them. */
interface InstrumentFaults {
    undecodableFrames: number;
    stampMismatches: number;
    duplicateReads: number;
    ackRefusals: number;
    maxSendLateMs: number;
    maxAckLateMs: number;
}

/** One run's room: three instances, fifteen sessions, and everything the sessions' sockets were sent. `…At` are `performance.now()` readings. */
interface RoomRun {
    readonly cluster: ReceiptCluster;
    readonly instances: readonly ClusterInstance[];
    readonly startedAt: number;
    readonly startedAtEpochMs: number;
    readonly senders: ReadonlyMap<string, EdgeOrderSender>;
    readonly sent: SentMessage[];
    readonly sentByMsgId: Map<string, SentMessage>;
    readonly arrivalsByRecipient: ReadonlyMap<string, EdgeOrderArrival[]>;
    readonly acceptances: Promise<void>[];
    readonly acks: Promise<void>[];
    readonly instrument: InstrumentFaults;
}

interface DelayedInstanceInput {
    readonly cluster: ReceiptCluster;
    readonly name: string;
    readonly delayMs: number;
    /** Every instance's database handle, which counts the statements issued through it. */
    readonly databases: PSqlSql[];
}

interface MachineLoad {
    readonly atStart: number;
    readonly atEnd: number;
    readonly waitedMs: number;
}

interface CellRunResult {
    readonly cell: string;
    readonly delayMs: number;
    readonly run: number;
    readonly messages: number;
    readonly offeredPerSecond: number;
    readonly acceptances: Readonly<Record<string, number>>;
    readonly complete: number;
    readonly completeBeforeDeadline: number;
    readonly timedOut: number;
    readonly unanswered: number;
    readonly sendToAdmittedMs: EdgeOrderSummary | null;
    readonly sendToCompleteMs: EdgeOrderSummary | null;
    readonly sendToLastAckOfferedMs: EdgeOrderSummary | null;
    readonly order: EdgeOrderFigures;
    readonly instrument: InstrumentFaults;
    readonly statementsPerMessage: number;
    readonly load: MachineLoad;
    /** With `EDGE_ORDER_RAW=1`: every send and first read, in milliseconds from the run's start, for another analysis. */
    readonly raw: RawRecords | undefined;
}

interface RawRecords {
    /** `[publisher, position, sent]`. */
    readonly sends: readonly (readonly [string, number, number])[];
    /**
     * Per recipient, in arrival order: `[publisher, position, arrived, earlier can arrive until, lowest open
     * position]`; the fourth is 0 when nothing earlier could arrive. A stamp's holes are not kept: only a refused or
     * timed-out send makes one.
     */
    readonly arrivals: Readonly<Record<string, readonly (readonly [string, number, number, number, number])[]>>;
}

const measureIt = process.env.RALLAR_EDGE_ORDER_MEASUREMENT === '1' ? it : it.skip;
const OUT = process.env.EDGE_ORDER_OUT;
const KEEPS_RAW = process.env.EDGE_ORDER_RAW === '1';
const RUNS = Number(process.env.EDGE_ORDER_RUNS ?? 3);
const DELAYS_MS = (process.env.EDGE_ORDER_DELAYS_MS ?? '0,5').split(',').map(Number);
const LOAD_LIMIT = Number(process.env.EDGE_ORDER_LOAD_LIMIT ?? 8);

// Spread over the instances: a, b, c, a, b.
const FIVE_PUBLISHERS = ['p00', 'p05', 'p10', 'p01', 'p06'];
const CELLS: readonly MeasuredCell[] = [
    { name: 'one-fast-5', publishers: ['p00'], intervalMs: 200, messagesPerPublisher: 100 },
    { name: 'one-fast-10', publishers: ['p00'], intervalMs: 100, messagesPerPublisher: 200 },
    // Above the browser's session admission budget of about 16.7 a second; reported as found.
    { name: 'one-fast-30', publishers: ['p00'], intervalMs: 33, messagesPerPublisher: 600 },
    { name: 'five-20s', publishers: FIVE_PUBLISHERS, intervalMs: 500, messagesPerPublisher: 40 },
    { name: 'five-45s', publishers: FIVE_PUBLISHERS, intervalMs: 500, messagesPerPublisher: 90 }
];
const SELECTED_CELLS = CELLS.filter((cell) => (process.env.EDGE_ORDER_CELLS?.split(',') ?? CELLS.map(({ name }) => name)).includes(cell.name));

const INSTANCE_NAMES = ['a', 'b', 'c'];
const SESSIONS_PER_INSTANCE = 5;
const PEERS = Array.from({ length: INSTANCE_NAMES.length * SESSIONS_PER_INSTANCE }, (_unused, index) => `p${String(index).padStart(2, '0')}`);
const POOL_SIZE = 10;
const LIFETIME_MS = 30_000;
/** A message's recipients offer their ACKs spread over this long after they read it. */
const ACK_SPREAD_MS = 100;
const SETTLE_AFTER_LAST_DEADLINE_MS = 15_000;
const LOAD_WAIT_BUDGET_MS = 30 * 60_000;
const LOAD_WAIT_STEP_MS = 30_000;
const TEST_TIMEOUT_MS = 45 * 60_000;

const TABLE_HEADER = [
    '| cell | +ms | run | load | accepted | complete by deadline | handed over by deadline | out of order (per recipient) | overtaken by p95/max ms | read lag p50/p95/max ms | sorted lag p50/p95/max ms | most held | gaps/late | first ten → last ten sorted p50 ms | rule |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'
].join('\n');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round1 = (value: number) => Math.round(value * 10) / 10;
let loadWaitedMs = 0;

// Every cell's first run before any cell's second: a stretch of machine load then touches one run of each.
for (let run = 1; run <= RUNS; run += 1) {
    for (const cell of SELECTED_CELLS) {
        for (const delayMs of DELAYS_MS) {
            measureIt(`edge-order room sends ${cell.name} +${delayMs} ms run ${run}`, async () => {
                const waitedMs = await waitForQuietMachine();
                const result = await measureCell(cell, delayMs, { run, waitedMs });
                if (OUT !== undefined) {
                    appendFileSync(OUT, `${JSON.stringify(result)}\n`);
                }
                console.log(`${run === 1 && cell === SELECTED_CELLS[0] && delayMs === DELAYS_MS[0] ? `${TABLE_HEADER}\n` : ''}${toTableRow(result)}`);
                expect(result.messages).toBe(cell.publishers.length * cell.messagesPerPublisher);
                expect(result.instrument).toMatchObject({ undecodableFrames: 0, stampMismatches: 0, ackRefusals: 0 });
            }, TEST_TIMEOUT_MS);
        }
    }
}

/** Waits, within one budget for the whole file, while the 1-minute load average is above the limit. */
async function waitForQuietMachine(): Promise<number> {
    const startedAt = Date.now();
    while (loadavg()[0]! > LOAD_LIMIT && loadWaitedMs + (Date.now() - startedAt) < LOAD_WAIT_BUDGET_MS) {
        await sleep(LOAD_WAIT_STEP_MS);
    }
    loadWaitedMs += Date.now() - startedAt;
    return Date.now() - startedAt;
}

async function measureCell(cell: MeasuredCell, delayMs: number, attempt: { run: number; waitedMs: number; }): Promise<CellRunResult> {
    const loadAtStart = loadavg()[0]!;
    const cluster = await createReceiptCluster();
    const databases: PSqlSql[] = [];
    const instances: ClusterInstance[] = [];
    for (const name of INSTANCE_NAMES) {
        instances.push(await startDelayedInstance({ cluster, name, delayMs, databases }));
    }
    const sockets = new Map<string, SimulatedWebSocket>();
    for (const peer of PEERS) {
        sockets.set(peer, await connect(readInstanceOf(instances, peer), peer));
    }
    const room = createRoomRun(cluster, instances, cell);
    sockets.forEach((socket, peer) => observeSocket(room, peer, socket));
    await sendRoomMessages(room, cell);
    const sendWindowMs = performance.now() - room.startedAt;
    await awaitTerminalReceipts(room);
    await Promise.allSettled(room.acceptances);
    await Promise.allSettled(room.acks);
    return {
        cell: cell.name,
        delayMs,
        run: attempt.run,
        offeredPerSecond: round1(room.sent.length / (sendWindowMs / 1000)),
        ...toReceiptFigures(room),
        order: await computeEdgeOrderFigures(toRunRecords(room), EDGE_ORDER_RECEIVER_DEFAULT_LIMITS),
        instrument: { ...room.instrument, maxSendLateMs: round1(room.instrument.maxSendLateMs), maxAckLateMs: round1(room.instrument.maxAckLateMs) },
        statementsPerMessage: Math.round(countStatements(databases) / room.sent.length),
        load: { atStart: round1(loadAtStart), atEnd: round1(loadavg()[0]!), waitedMs: attempt.waitedMs },
        raw: KEEPS_RAW ? toRawRecords(room) : undefined
    };
}

function countStatements(databases: readonly PSqlSql[]): number {
    return databases.reduce((sum, database) => sum + (database.getExecutorCounters?.().statements ?? 0), 0);
}

/** One WS server instance of the run's cluster, on a client of its own whose every round trip is `delayMs` away. */
async function startDelayedInstance(input: DelayedInstanceInput): Promise<ClusterInstance> {
    const { cluster } = input;
    const client = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), POOL_SIZE);
    cluster.clients.push(client);
    const delayed = createDelayedPSqlSql({ sql: client, delayMs: input.delayMs, sleep });
    const database = createPSqlCounterScope(delayed, { timesBeginWait: false });
    input.databases.push(database);
    const repository = new PSqlRuntimeStateRepository(database);
    const instance = await createClusterInstance({
        name: RECEIPT_SERVER_PEER_ID,
        outboundStores: createDefaultPSqlALOutboundRuntimeStores({
            repository,
            namespace: cluster.storeId,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        }),
        inboundStores: createDefaultPSqlALInboundRuntimeStores({ repository, namespace: cluster.storeId }),
        inboundVolatileStores: undefined,
        receiptRecordStores: createPSqlALReceiptRecordStores({ repository, namespace: cluster.storeId, nowMs: Date.now }),
        receiptObserver: undefined,
        roomView: { inSync: true },
        bus: cluster.bus,
        publisherId: `${input.name}-${cluster.runId}`,
        engine: new InboxOutboxEngine(),
        roomPeerIds: PEERS
    });
    instance.engine.start();
    return instance;
}

function createRoomRun(cluster: ReceiptCluster, instances: readonly ClusterInstance[], cell: MeasuredCell): RoomRun {
    return {
        cluster,
        instances,
        startedAt: performance.now(),
        startedAtEpochMs: Date.now(),
        // One stream per publisher and run, as a page would mint one per channel.
        senders: new Map(cell.publishers.map((publisher) => [
            publisher,
            new EdgeOrderSender(`${cluster.runId}-${publisher}`, EDGE_ORDER_ACKNOWLEDGED_SETTLE_MS)
        ])),
        sent: [],
        sentByMsgId: new Map(),
        arrivalsByRecipient: new Map(PEERS.map((peer) => [peer, []])),
        acceptances: [],
        acks: [],
        instrument: { undecodableFrames: 0, stampMismatches: 0, duplicateReads: 0, ackRefusals: 0, maxSendLateMs: 0, maxAckLateMs: 0 }
    };
}

function readInstanceOf(instances: readonly ClusterInstance[], peer: string): ClusterInstance {
    return instances[Math.floor(PEERS.indexOf(peer) / SESSIONS_PER_INSTANCE)]!;
}

const toEpochMs = (room: RoomRun, at: number) => room.startedAtEpochMs + (at - room.startedAt);

/** Reads every frame the instance writes to the session's socket, at the moment it is written. */
function observeSocket(room: RoomRun, peer: string, socket: SimulatedWebSocket): void {
    const send = socket.send.bind(socket);
    socket.send = (data) => {
        const at = performance.now();
        const written = send(data);
        readFrame(room, peer, String(data), at);
        return written;
    };
}

function readFrame(room: RoomRun, peer: string, data: string, at: number): void {
    let message: ALMessage;
    try {
        message = decodePersistedALMessage(data);
    }
    catch {
        room.instrument.undecodableFrames += 1;
        return;
    }
    if (message.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID) {
        readReceipt(room, peer, message, at);
    }
    else if (!isALControlTypeId(message.payload.typeId)) {
        readRoomMessage(room, peer, message, at);
    }
}

/** The publisher's own receipts: `admitted`, then the terminal one, which its stream's later stamps read as the send's end. */
function readReceipt(room: RoomRun, peer: string, message: ALMessage, at: number): void {
    const receipt = decodeALReceiptPayload(JSON.parse(message.payload.resource));
    const sent = room.sentByMsgId.get(receipt.msgId);
    if (sent === undefined || peer !== sent.publisher) {
        return;
    }
    if (receipt.phase === 'admitted') {
        sent.admittedAt ??= at;
        return;
    }
    if (sent.terminalAt === undefined) {
        sent.terminalAt = at;
        sent.terminalPhase = receipt.phase;
    }
}

/** A recipient's first read of a room message is kept in arrival order with the stamp that arrived, and acknowledged. */
function readRoomMessage(room: RoomRun, peer: string, message: ALMessage, at: number): void {
    const sent = room.sentByMsgId.get(message.id.msgId);
    if (sent === undefined || peer === sent.publisher) {
        return;
    }
    if (sent.readBy.has(peer)) {
        room.instrument.duplicateReads += 1;
        return;
    }
    sent.readBy.add(peer);
    const { resource } = message.payload;
    const stamp = resource === sent.resource ? decodeEdgeOrderWirePayload(resource)?.stamp : undefined;
    if (stamp === undefined) {
        room.instrument.stampMismatches += 1;
        return;
    }
    room.arrivalsByRecipient.get(peer)?.push({
        publisher: sent.publisher,
        stamp,
        arrivedAtMs: toEpochMs(room, at),
        expiresAtMs: sent.expiresAtEpochMs,
        byteLength: computeUtf8ByteLength(resource)
    });
    const order = sent.recipients.indexOf(peer);
    room.acks.push(offerAck(room, sent, { peer, target: at + (order * ACK_SPREAD_MS) / (sent.recipients.length - 1) }));
}

async function offerAck(room: RoomRun, sent: SentMessage, offer: { peer: string; target: number; }): Promise<void> {
    await sleep(Math.max(0, offer.target - performance.now()));
    const offeredAt = performance.now();
    room.instrument.maxAckLateMs = Math.max(room.instrument.maxAckLateMs, offeredAt - offer.target);
    sent.lastAckOfferedAt = Math.max(sent.lastAckOfferedAt ?? 0, offeredAt);
    const ack = receiverAck({ msgId: sent.msgId, originPeerId: sent.publisher, recipient: offer.peer, nowMs: Date.now() });
    const accepted = await readInstanceOf(room.instances, offer.peer).service.acceptIncomingMessage(ack, offer.peer);
    if (accepted.left !== undefined) {
        room.instrument.ackRefusals += 1;
    }
}

/** Each publisher sends every `intervalMs`; the publishers' sends are spread evenly inside the interval. */
async function sendRoomMessages(room: RoomRun, cell: MeasuredCell): Promise<void> {
    const lanes = cell.publishers.length;
    for (let slot = 0; slot < lanes * cell.messagesPerPublisher; slot += 1) {
        const lane = slot % lanes;
        const target = room.startedAt + Math.floor(slot / lanes) * cell.intervalMs + (lane * cell.intervalMs) / lanes;
        await sleep(Math.max(0, target - performance.now()));
        room.instrument.maxSendLateMs = Math.max(room.instrument.maxSendLateMs, performance.now() - target);
        room.acceptances.push(sendRoomMessage(room, cell.publishers[lane]!));
    }
}

/**
 * The position is taken at the call, before the instance is asked: the order an application's `send` calls have.
 * Every measured send is retried and asks a receipt, and names no supersedence key. From then on the stream reads
 * the send's end from its terminal receipt, as a page reads it from the send's handle.
 */
async function sendRoomMessage(room: RoomRun, publisher: string): Promise<void> {
    const sentAt = performance.now();
    const nowMs = Date.now();
    const sender = room.senders.get(publisher)!;
    const position = sender.openSend(true, undefined);
    const stamp = sender.stampSend(position, nowMs, undefined);
    const sent: SentMessage = {
        msgId: `room-${room.cluster.runId}-${publisher}-m${String(position).padStart(3, '0')}`,
        publisher,
        stamp,
        resource: toEdgeOrderWireJson(stamp, '{}'),
        recipients: PEERS.filter((peer) => peer !== publisher),
        sentAt,
        expiresAtEpochMs: nowMs + LIFETIME_MS,
        readBy: new Set(),
        acceptance: undefined,
        admittedAt: undefined,
        terminalAt: undefined,
        terminalPhase: undefined,
        lastAckOfferedAt: undefined
    };
    room.sent.push(sent);
    room.sentByMsgId.set(sent.msgId, sent);
    sender.observeSend(position, { expiresAtMs: sent.expiresAtEpochMs, getEnd: () => toSendEnd(sent) });
    const unstamped = roomMessage({ msgId: sent.msgId, originPeerId: publisher, nowMs, lifetimeMs: LIFETIME_MS });
    const message: ALMessage = { ...unstamped, payload: { ...unstamped.payload, resource: sent.resource } };
    const accepted = await readInstanceOf(room.instances, publisher).service.acceptIncomingMessage(message, publisher);
    sent.acceptance = accepted.left === undefined ? accepted.right?.kind ?? 'accepted' : 'refused';
}

/** `complete` says every recipient acknowledged; any other terminal receipt says no copy can be handed over any more. */
function toSendEnd(sent: SentMessage): EdgeOrderSender.SendEnd {
    if (sent.terminalPhase === undefined) {
        return 'open';
    }
    return sent.terminalPhase === 'complete' ? 'delivered' : 'undelivered';
}

/** Until every send has its terminal receipt, or the last deadline is well past. */
async function awaitTerminalReceipts(room: RoomRun): Promise<void> {
    const lastDeadline = Math.max(...room.sent.map((sent) => sent.expiresAtEpochMs));
    while (room.sent.some((sent) => sent.terminalAt === undefined) && Date.now() < lastDeadline + SETTLE_AFTER_LAST_DEADLINE_MS) {
        await sleep(250);
    }
}

function toReceiptFigures(room: RoomRun) {
    const complete = room.sent.filter((sent) => sent.terminalPhase === 'complete');
    const lagTo = (read: (sent: SentMessage) => number | undefined) =>
        summarizeEdgeOrderValues(room.sent.flatMap((sent) => {
            const at = read(sent);
            return at === undefined ? [] : [at - sent.sentAt];
        }));
    const acceptances: Record<string, number> = {};
    for (const sent of room.sent) {
        const answer = sent.acceptance ?? 'unsettled';
        acceptances[answer] = (acceptances[answer] ?? 0) + 1;
    }
    return {
        messages: room.sent.length,
        acceptances,
        complete: complete.length,
        completeBeforeDeadline: complete.filter((sent) => toEpochMs(room, sent.terminalAt!) < sent.expiresAtEpochMs).length,
        timedOut: room.sent.filter((sent) => sent.terminalPhase === 'timed-out').length,
        unanswered: room.sent.filter((sent) => sent.terminalAt === undefined).length,
        sendToAdmittedMs: lagTo((sent) => sent.admittedAt),
        sendToCompleteMs: lagTo((sent) => sent.terminalPhase === 'complete' ? sent.terminalAt : undefined),
        sendToLastAckOfferedMs: lagTo((sent) => sent.lastAckOfferedAt)
    };
}

function toRunRecords(room: RoomRun) {
    return {
        sends: room.sent.map((sent) => ({
            publisher: sent.publisher,
            position: sent.stamp.position,
            sentAtMs: toEpochMs(room, sent.sentAt),
            expiresAtMs: sent.expiresAtEpochMs
        })),
        peers: PEERS,
        arrivalsByRecipient: room.arrivalsByRecipient
    };
}

function toRawRecords(room: RoomRun): RawRecords {
    const fromStart = (epochMs: number) => round1(epochMs - room.startedAtEpochMs);
    return {
        sends: room.sent.map((sent) => [sent.publisher, sent.stamp.position, round1(sent.sentAt - room.startedAt)] as const),
        arrivals: Object.fromEntries([...room.arrivalsByRecipient].map(([peer, arrivals]) => [
            peer,
            arrivals.map(({ publisher, stamp, arrivedAtMs }) =>
                [
                    publisher,
                    stamp.position,
                    fromStart(arrivedAtMs),
                    stamp.earlierCanArriveUntilMs === undefined ? 0 : fromStart(stamp.earlierCanArriveUntilMs),
                    stamp.lowestOpenPosition
                ] as const
            )
        ]))
    };
}

function toTableRow(result: CellRunResult): string {
    const { order } = result;
    const triple = (summary: EdgeOrderSummary | null) => summary === null ? '-' : `${summary.p50}/${summary.p95}/${summary.max}`;
    const percent = (share: number) => `${round1(share * 100)} %`;
    const spread = order.outOfOrderSharePerRecipient;
    return `| ${
        [
            result.cell,
            result.delayMs,
            result.run,
            `${result.load.atStart}→${result.load.atEnd}`,
            Object.entries(result.acceptances).map(([answer, count]) => `${answer} ${count}`).join(', '),
            `${result.completeBeforeDeadline}/${result.messages}`,
            `${order.handedOverBeforeDeadline}/${order.expectedHandOvers}`,
            `${percent(order.outOfOrderShare)} (${percent(spread.min)}–${percent(spread.max)})`,
            order.overtakenByMs === null ? '-' : `${order.overtakenByMs.p95}/${order.overtakenByMs.max}`,
            triple(order.lagMs.raw),
            triple(order.lagMs.sorted),
            order.mostHeld,
            `${order.gaps}/${order.lateDrops}`,
            `${order.firstTenLagMs.sorted?.p50 ?? '-'} → ${order.lastTenLagMs.sorted?.p50 ?? '-'}`,
            order.passRule.passes ? 'pass' : 'fail'
        ].join(' | ')
    } |`;
}
