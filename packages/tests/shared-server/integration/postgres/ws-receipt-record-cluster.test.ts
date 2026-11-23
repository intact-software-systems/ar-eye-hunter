import { describe, expect, it, onTestFinished } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALReceiptRecordHeadKey, type ALReceiptRecordRef } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { toALReceiptRecordWorkKey } from '@shared/alm/receipt-record/al-receipt-record-work-entry.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    INBOX_OUTBOX_ENGINE_MAX_IDLE_MS,
    INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO,
    InboxOutboxEngine
} from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { toWsQueueBoxServerEndedReceiptControlId } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-aggregation.ts';

import type { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    connect,
    createBridgeBus,
    createClusterInstance,
    readOriginReceiptPhases,
    readOriginReceipts,
    readOriginTerminalReceipt,
    RECEIPT_SERVER_PEER_ID,
    receiverAck,
    roomMessage,
    toReceiptSets,
    type ClusterInstance
} from '../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type TerminablePostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import { holdPostgresCommit } from './test-support/hold-postgres-commit.ts';
import { createWorkerHold, type WorkerHold } from './test-support/postgres-worker-hold.ts';
import { awaitHoldArrival, racePastHeldCommit } from './test-support/race-past-held-commit.ts';
import {
    recordPostgresStatements,
    toRecordedPostgresStatementShape,
    type PostgresStatementLog
} from './test-support/record-postgres-statements.ts';

const ORIGIN = 'o';
const ROOM = ['o', 'r1', 'r2'];
/** A room view wider than `ROOM`: a receipt that expects `r3` was opened from this view, not from the admission row. */
const WIDER_ROOM = [...ROOM, 'r3'];
const LIFETIME_MS = 30_000;
/** A deadline the survivors' engines reach in real time: the PostgreSQL queue calls work due on the database clock. */
const DEADLINE_LIFETIME_MS = 2_000;
const POLL = { timeout: 20_000 } as const;
const CASE_TIMEOUT_MS = 60_000;
/**
 * How long a second terminal receipt would take to reach the origin, so a case may assert there is none. A second
 * receipt is one under another control id: the outbox resends a receipt control the origin never acknowledges, under
 * the same id, so the readers count each control id once. The window is the next
 * readiness read of an instance that did not commit the end (the engine's idle interval stretched by its jitter), one
 * more idle interval for the outbox row's dequeue and send, and one second for their statements.
 */
const TERMINAL_SETTLE_MS = AL_WORK_READINESS_MEMORY_MS * (1 + INBOX_OUTBOX_ENGINE_SCHEDULE_JITTER_RATIO) +
    INBOX_OUTBOX_ENGINE_MAX_IDLE_MS + 1_000;

/** One run: its rows carry `runId`, its instances share one store id, one bus and the test's own reader of the record. */
interface ReceiptCluster {
    readonly runId: string;
    readonly storeId: string;
    readonly clients: TerminablePostgresSql[];
    readonly bus: ReturnType<typeof createBridgeBus>;
    readonly originSockets: SimulatedWebSocket[];
    /** Reads the record every instance writes, through a client no instance uses. */
    readonly reader: ALReceiptRecord;
    /** The record's work queue, read through the reader's client. */
    readonly readerWorkQueue: QueueBoxResourceEntryRepository;
    readonly recordNamespace: string;
}

interface StartInstanceInput {
    /** The instance's cluster publisher id. */
    readonly name: string;
    readonly roomPeerIds: readonly string[];
    /** When set, the record's stores sit on a client of their own whose every commit waits for this hold. */
    readonly recordHold: WorkerHold | undefined;
    /** When set, every statement of the instance's one client is recorded here. */
    readonly log: PostgresStatementLog | undefined;
    readonly starts: boolean;
}

interface ReceiptInstance extends ClusterInstance {
    /** The client the instance's record stores use: its own when they are held, else the instance's one client. */
    readonly recordClient: TerminablePostgresSql;
}

/** Starts one `acceptIncomingMessage` on an instance. */
type StartAcceptance = () => ReturnType<ClusterInstance['service']['acceptIncomingMessage']>;

type ReceiptTrio = Readonly<Record<'a' | 'b' | 'c', ReceiptInstance>>;

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL WS receipt record across instances', () => {
    // Pins an instance that counts on a record of its own: the receipt never completes, and the shared record holds
    // no ended head.
    it('completes a receipt admitted on one instance and confirmed on two others', async () => {
        const cluster = await createReceiptCluster();
        const { msgId } = await completeOneReceipt(cluster, await startThree(cluster), 'complete');

        expect(phases(cluster, msgId)).toEqual(['admitted', 'complete']);
        expect(terminal(cluster, msgId)).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
        const stored = (await cluster.reader.read(toRef(msgId))).right?.head;
        expect(stored).toMatchObject({ phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'] });
    }, CASE_TIMEOUT_MS);

    // Pins a receipt that dies with the instance that admitted it.
    it('completes a receipt whose admitting instance is disposed after admitted', async () => {
        const cluster = await createReceiptCluster();
        const { a, b, c } = await startThree(cluster);
        const msgId = toMsgId(cluster, 'disposed');
        await connectOrigin(cluster, a);
        expect((await a.service.acceptIncomingMessage(message(msgId, LIFETIME_MS), ORIGIN)).right?.kind).toBe('admitted');
        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted']);

        await loseInstance(a);
        const onB = await connectOrigin(cluster, b);
        expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        expect((await c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2')).left).toBeUndefined();

        const completeOnB = () => readOriginReceipts([onB], msgId).filter(({ receipt }) => receipt.phase === 'complete');
        await expect.poll(() => completeOnB().length, POLL).toBe(1);
        await settleTerminalReceipts();
        expect(completeOnB()).toHaveLength(1);
        expect(completeOnB()[0]!.receipt.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
    }, CASE_TIMEOUT_MS);

    // Pins deadline work that only the lost admitting instance would claim: the receipt is never ended.
    it('ends the receipt timed-out from the deadline work a survivor claims', async () => {
        const cluster = await createReceiptCluster();
        const { a, b } = await startThree(cluster);
        const msgId = toMsgId(cluster, 'deadline');
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(msgId, DEADLINE_LIFETIME_MS), ORIGIN);
        expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted']);

        await loseInstance(a);
        // Still open once its admitting instance is gone, so only a survivor can end it.
        expect((await cluster.reader.read(toRef(msgId))).right?.head.phase).toBe('open');
        const onB = await connectOrigin(cluster, b);

        const phasesOnB = () => readOriginReceiptPhases([onB], msgId);
        await expect.poll(phasesOnB, POLL).toEqual(['timed-out']);
        await settleTerminalReceipts();
        expect(phasesOnB()).toEqual(['timed-out']);
        expect(phases(cluster, msgId)).toEqual(['admitted', 'timed-out']);
        expect(terminal(cluster, msgId)).toMatchObject({ expectedRecipientPeerIds: ['r1', 'r2'], confirmedRecipientPeerIds: ['r1'] });
    }, CASE_TIMEOUT_MS);

    // Pins a copy re-sent to another instance after the end going unanswered, or answered under the ended control id.
    it('answers a re-sent copy on another instance after the end with the terminal receipt', async () => {
        const cluster = await createReceiptCluster();
        const trio = await startThree(cluster);
        await connectOrigin(cluster, trio.c);
        const { msgId, sent } = await completeOneReceipt(cluster, trio, 'resent');

        expect((await trio.c.service.acceptIncomingMessage(sent, ORIGIN)).right).toEqual({ kind: 'duplicate' });

        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete', 'complete']);
        await settleTerminalReceipts();
        expect(phases(cluster, msgId)).toEqual(['admitted', 'complete', 'complete']);
        const [ended, again] = readOriginReceipts(cluster.originSockets, msgId).filter(({ receipt }) => receipt.phase === 'complete');
        expect(again!.controlId).not.toBe(ended!.controlId);
        expect(toReceiptSets(again!.receipt)).toEqual(toReceiptSets(ended!.receipt));
    }, CASE_TIMEOUT_MS);

    // Pins a receipt never started when the admitting instance died between its admission's commit and its `open`, and
    // a survivor opening it from its own view of the room instead of the audience the admission row froze: the
    // survivors' view holds `r3`, the admitting instance's did not.
    it('opens the record from a re-sent copy when the admitting instance was lost between its admission and its open', async () => {
        const cluster = await createReceiptCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), recordHold: hold, starts: false });
        const { b, c } = await startTwo(cluster, WIDER_ROOM);
        const msgId = toMsgId(cluster, 'lost-open');
        const sent = message(msgId, LIFETIME_MS);
        await connectOrigin(cluster, a);
        await loseInsideHeldOpen(a, hold, () => a.service.acceptIncomingMessage(sent, ORIGIN));

        expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        expect((await c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2')).left).toBeUndefined();
        await connectOrigin(cluster, b);
        expect((await b.service.acceptIncomingMessage(sent, ORIGIN)).right).toEqual({ kind: 'duplicate' });

        await expect.poll(() => phases(cluster, msgId)[0], POLL).toBe('admitted');
        expect(readOriginReceipts(cluster.originSockets, msgId)[0]!.receipt.expectedRecipientPeerIds).toEqual(['r1', 'r2']);
        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete']);
        expect(terminal(cluster, msgId)?.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
        expect(await readHeadCount(cluster, msgId)).toBe(1);
    }, CASE_TIMEOUT_MS);

    // The subject of the deleted ws-relayed-leader-ack.test.ts: pins a leader's ACK refused or left uncounted on an
    // instance other than the one that admitted the send.
    it('completes a group-leader receipt when the leader acknowledges on another instance than the admitting one', async () => {
        const cluster = await createReceiptCluster();
        const a = await startInstance(cluster, instanceInput('a', ['leader']));
        const b = await startInstance(cluster, instanceInput('b', ['leader']));
        await connect(b, 'leader');
        const msgId = toMsgId(cluster, 'leader');
        await connectOrigin(cluster, a);
        const shot: ALMessage = { ...message(msgId, LIFETIME_MS), delivery: { reliability: 'at-least-once', ack: 'group-leader' } };

        expect((await a.service.acceptIncomingMessage(shot, ORIGIN)).right?.kind).toBe('admitted');
        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted']);
        expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'leader'), 'leader')).left).toBeUndefined();

        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete']);
        await settleTerminalReceipts();
        expect(phases(cluster, msgId)).toEqual(['admitted', 'complete']);
        expect(terminal(cluster, msgId)).toMatchObject({
            expectedRecipientPeerIds: ['leader'],
            confirmedRecipientPeerIds: ['leader'],
            outsideAudienceRecipientPeerIds: []
        });
    }, CASE_TIMEOUT_MS);

    // Memory serialises writes and cannot hold a count that read an open head until after another instance's `end`:
    // pins that late confirmation turning the ended receipt complete, joining its sets, or answering it twice.
    it('keeps the deadline end of a receipt whose last count commits after it', async () => {
        const cluster = await createReceiptCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const b = await startInstance(cluster, { ...instanceInput('b', ROOM), recordHold: hold, starts: false });
        const c = await startInstance(cluster, instanceInput('c', ROOM));
        await connect(b, 'r2');
        await connect(c, 'r1');
        const msgId = toMsgId(cluster, 'late-count');
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(msgId, DEADLINE_LIFETIME_MS), ORIGIN);
        expect((await c.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();

        const race = await racePastHeldCommit({
            hold,
            startHeld: () => b.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2'),
            startRaced: async () => {
                // The held count read this head open, and its deadline has not yet passed.
                expect((await cluster.reader.read(toRef(msgId))).right?.head.phase).toBe('open');
                await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'timed-out']);
            },
            blockedAfterMs: POLL.timeout
        });

        expect(race.raced).toBe('finished');
        expect(race.heldResult.left).toBeUndefined();
        await settleTerminalReceipts();
        expect(phases(cluster, msgId)).toEqual(['admitted', 'timed-out']);
        expect(terminal(cluster, msgId)).toMatchObject({ confirmedRecipientPeerIds: ['r1'] });
        const stored = (await cluster.reader.read(toRef(msgId))).right?.head;
        expect(stored).toMatchObject({ phase: 'timed-out', confirmedRecipientPeerIds: ['r1'] });
    }, CASE_TIMEOUT_MS);

    // Pins a losing `end` that delivers a second terminal receipt or surfaces as a failure: the last two ACKs commit
    // together on two instances, so both may read a complete set and both call `end`.
    it('delivers one complete receipt when the last two ACKs are counted at once on two instances', async () => {
        const cluster = await createReceiptCluster();
        const holds = { b: createWorkerHold(), c: createWorkerHold() };
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const b = await startInstance(cluster, { ...instanceInput('b', ROOM), recordHold: holds.b, starts: false });
        const c = await startInstance(cluster, { ...instanceInput('c', ROOM), recordHold: holds.c, starts: false });
        await connect(b, 'r1');
        await connect(c, 'r2');
        const msgId = toMsgId(cluster, 'both-end');
        const origin = await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(msgId, LIFETIME_MS), ORIGIN);

        const results = await countTogether([
            { hold: holds.b, count: () => b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1') },
            { hold: holds.c, count: () => c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2') }
        ]);

        expect(results.map((result) => result.left)).toEqual([undefined, undefined]);
        const endedWork = toALReceiptRecordWorkKey(cluster.recordNamespace, 'ended', toRef(msgId));
        await expect.poll(async () => (await cluster.readerWorkQueue.getItem(endedWork))?.status, POLL).toBe(EntityStatus.COMPLETED);
        await settleTerminalReceipts();
        const answered = readOriginReceipts([origin], msgId);
        expect(answered.map(({ receipt }) => receipt.phase)).toEqual(['admitted', 'complete']);
        expect(answered[1]!.controlId).toBe(toWsQueueBoxServerEndedReceiptControlId(toRef(msgId)));
        expect((await cluster.reader.read(toRef(msgId))).right?.head).toMatchObject({
            phase: 'complete',
            confirmedRecipientPeerIds: ['r1', 'r2']
        });
    }, CASE_TIMEOUT_MS);

    // Pins what one ACK costs the server when its head is open and it does not complete the set, the common case: the
    // hook's head and prefix reads, the inbound runtime's control-owner read, then the record's count (the head and
    // the confirmation key in one read, the insert in one transaction, the prefix read for the tally). Eight round
    // trips with BEGIN and COMMIT; a change that adds a statement or a transaction to every ACK shows here.
    it('counts an ACK that finds its head and does not complete the set in a pinned number of statements', async () => {
        const cluster = await createReceiptCluster();
        const log: PostgresStatementLog = { statements: [], transactions: 0 };
        const only = await startInstance(cluster, { ...instanceInput('a', ['o', 'r1', 'r2', 'r3']), log, starts: false });
        await connect(only, 'r1');
        const msgId = toMsgId(cluster, 'pin');
        await connectOrigin(cluster, only);
        expect((await only.service.acceptIncomingMessage(message(msgId, LIFETIME_MS), ORIGIN)).right?.kind).toBe('admitted');
        await expect.poll(async () => (await cluster.reader.read(toRef(msgId))).right?.head.phase, POLL).toBe('open');
        await waitForQuietStatements(log);
        log.statements.splice(0);
        log.transactions = 0;

        expect((await only.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        // A statement the ACK starts after it answers is pinned too, never left to race the assertion.
        await waitForQuietStatements(log);

        expect(log.transactions).toBe(1);
        expect(log.statements.map(toRecordedPostgresStatementShape)).toEqual([
            { verb: 'select', transaction: null },
            { verb: 'select', transaction: null },
            { verb: 'select', transaction: null },
            { verb: 'select', transaction: null },
            { verb: 'insert', transaction: 1 },
            { verb: 'select', transaction: null }
        ]);
        expect((await cluster.reader.read(toRef(msgId))).right?.tally.confirmedRecipientPeerIds).toEqual(['r1']);
    }, CASE_TIMEOUT_MS);
});

/** The run's cleanup is registered first, so it runs after every instance's own disposal. */
async function createReceiptCluster(): Promise<ReceiptCluster> {
    const runId = crypto.randomUUID();
    const clients: TerminablePostgresSql[] = [];
    onTestFinished(async () => await closeReceiptCluster(runId, clients));
    const storeId = `ws-receipt-cluster-${runId}`;
    const readerClient = await openClient(clients);
    const { backend, namespace } = createPSqlALReceiptRecordStores({
        repository: new PSqlRuntimeStateRepository(readerClient),
        namespace: storeId,
        nowMs: Date.now
    });
    return {
        runId,
        storeId,
        clients,
        bus: createBridgeBus(),
        originSockets: [],
        reader: new ALReceiptRecord({ backend, namespace, nowMs: Date.now }),
        readerWorkQueue: backend.workQueue,
        recordNamespace: namespace
    };
}

/**
 * Deletes the run's rows before asserting none remain, then ends every client whatever happened; the first client
 * is the reader's, which no instance uses.
 */
async function closeReceiptCluster(runId: string, clients: readonly TerminablePostgresSql[]): Promise<void> {
    try {
        const [reader] = clients;
        if (reader !== undefined) {
            const deletes = await Promise.allSettled([deletePostgresRunRows(reader, runId)]);
            expect(deletes.filter(({ status }) => status === 'rejected')).toEqual([]);
            expect(await readPostgresRunRowCounts(reader, runId)).toEqual(NO_POSTGRES_RUN_ROWS);
        }
    }
    finally {
        await Promise.allSettled(clients.map(async (client) => await client.end()));
    }
}

async function openClient(clients: TerminablePostgresSql[]): Promise<TerminablePostgresSql> {
    const client = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 10);
    clients.push(client);
    return client;
}

function instanceInput(name: string, roomPeerIds: readonly string[]): StartInstanceInput {
    return { name, roomPeerIds, recordHold: undefined, log: undefined, starts: true };
}

/**
 * Every instance shares the run's store id for its inbound, outbound and record stores, and the server's name, as
 * api-v1's instances share `wsRuntimeName`: an ended receipt's repeat is the outbound owner's duplicate only then.
 */
async function startInstance(cluster: ReceiptCluster, input: StartInstanceInput): Promise<ReceiptInstance> {
    const client = await openClient(cluster.clients);
    const sql: PSqlSql = input.log === undefined ? client : recordPostgresStatements(client, input.log, null);
    const recordClient = input.recordHold === undefined ? client : await openClient(cluster.clients);
    const recordSql = input.recordHold === undefined ? sql : holdPostgresCommit(recordClient, input.recordHold);
    const repository = new PSqlRuntimeStateRepository(sql);
    const receiptRecordStores = createPSqlALReceiptRecordStores({
        repository: new PSqlRuntimeStateRepository(recordSql),
        namespace: cluster.storeId,
        nowMs: Date.now
    });
    expect(receiptRecordStores.namespace).toBe(cluster.recordNamespace);
    const instance = await createClusterInstance({
        name: RECEIPT_SERVER_PEER_ID,
        outboundStores: createDefaultPSqlALOutboundRuntimeStores({
            repository,
            namespace: cluster.storeId,
            decodePrepared: decodeWsQueueBoxServerPreparedMessage
        }),
        inboundStores: createDefaultPSqlALInboundRuntimeStores({ repository, namespace: cluster.storeId }),
        inboundVolatileStores: undefined,
        receiptRecordStores,
        receiptObserver: undefined,
        roomView: { inSync: true },
        bus: cluster.bus,
        publisherId: `${input.name}-${cluster.runId}`,
        engine: new InboxOutboxEngine(),
        roomPeerIds: input.roomPeerIds
    });
    if (input.starts) {
        instance.engine.start();
    }
    return { ...instance, recordClient };
}

async function startThree(cluster: ReceiptCluster): Promise<ReceiptTrio> {
    const a = await startInstance(cluster, instanceInput('a', ROOM));
    return { a, ...await startTwo(cluster, ROOM) };
}

/** Two started instances whose view of the room is `roomPeerIds`, `r1` connected to `b` and `r2` to `c`. */
async function startTwo(cluster: ReceiptCluster, roomPeerIds: readonly string[]): Promise<Omit<ReceiptTrio, 'a'>> {
    const b = await startInstance(cluster, instanceInput('b', roomPeerIds));
    const c = await startInstance(cluster, instanceInput('c', roomPeerIds));
    await connect(b, 'r1');
    await connect(c, 'r2');
    return { b, c };
}

/** An instance lost as a process is: its service disposed and its engine stopped, its sockets left as they were. */
async function loseInstance(instance: ClusterInstance): Promise<void> {
    await instance.service.dispose();
    await instance.engine.stop();
}

/**
 * Starts `admit` on the instance whose record commits wait at `hold`, and loses the instance and its record client
 * once the admission's `open` is written and uncommitted, so PostgreSQL rolls the `open` back. The admission is never
 * awaited; the hold is released whatever happens, so no transaction stays held past the case.
 */
async function loseInsideHeldOpen(instance: ReceiptInstance, hold: WorkerHold, admit: StartAcceptance): Promise<void> {
    const admitting = admit();
    admitting.catch(() => undefined);
    try {
        await awaitHoldArrival(hold, admitting);
        await loseInstance(instance);
        await instance.recordClient.terminate();
    }
    finally {
        hold.release();
    }
}

interface HeldCount {
    readonly hold: WorkerHold;
    readonly count: StartAcceptance;
}

/** Holds each count's confirmation uncommitted until every one is written, then lets them all commit at once. */
async function countTogether(counts: readonly HeldCount[]): Promise<Awaited<ReturnType<HeldCount['count']>>[]> {
    const counting = counts.map(({ count }) => count());
    try {
        await Promise.all(counts.map(async ({ hold }, index) => await awaitHoldArrival(hold, counting[index]!)));
    }
    finally {
        counts.forEach(({ hold }) => hold.release());
    }
    return await Promise.all(counting);
}

/** Waits as long as a second terminal receipt would take to reach the origin (`TERMINAL_SETTLE_MS`). */
async function settleTerminalReceipts(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_SETTLE_MS));
}

async function connectOrigin(cluster: ReceiptCluster, instance: ClusterInstance): Promise<SimulatedWebSocket> {
    const socket = await connect(instance, ORIGIN);
    cluster.originSockets.push(socket);
    return socket;
}

/** Admitted on `a`, r1 counted on `b` and r2 on `c`, until the origin reads `complete`. */
async function completeOneReceipt(
    cluster: ReceiptCluster,
    { a, b, c }: ReceiptTrio,
    name: string
): Promise<Readonly<{ msgId: string; sent: ALMessage; }>> {
    const msgId = toMsgId(cluster, name);
    const sent = message(msgId, LIFETIME_MS);
    await connectOrigin(cluster, a);
    expect((await a.service.acceptIncomingMessage(sent, ORIGIN)).right?.kind).toBe('admitted');
    await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted']);
    expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
    expect((await c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2')).left).toBeUndefined();
    await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete']);
    return { msgId, sent };
}

/** Batches that run after an operation answers have settled once a quarter second passes without a statement. */
async function waitForQuietStatements(log: PostgresStatementLog): Promise<void> {
    let seen = -1;
    await expect.poll(() => {
        const quiet = log.statements.length === seen;
        seen = log.statements.length;
        return quiet;
    }, { ...POLL, interval: 250 }).toBe(true);
}

function toMsgId(cluster: ReceiptCluster, name: string): string {
    return `room-${cluster.runId}-${name}`;
}

function toRef(msgId: string): ALReceiptRecordRef {
    return { originPeerId: ORIGIN, msgId };
}

function message(msgId: string, lifetimeMs: number): ALMessage {
    return roomMessage({ msgId, originPeerId: ORIGIN, nowMs: Date.now(), lifetimeMs });
}

function ackOf(msgId: string, recipient: string): ALMessage {
    return receiverAck({ msgId, originPeerId: ORIGIN, recipient, nowMs: Date.now() });
}

async function readHeadCount(cluster: ReceiptCluster, msgId: string): Promise<number> {
    const [reader] = cluster.clients;
    const rows = await reader!<Array<{ readonly count: number; }>>`
        select count(*)::int as count from runtime_state_store
        where store_namespace = ${cluster.recordNamespace}
            and store_key = ${toALReceiptRecordHeadKey(cluster.recordNamespace, toRef(msgId))}
    `;
    return rows[0]?.count ?? 0;
}

function phases(cluster: ReceiptCluster, msgId: string): ReturnType<typeof readOriginReceiptPhases> {
    return readOriginReceiptPhases(cluster.originSockets, msgId);
}

function terminal(cluster: ReceiptCluster, msgId: string): ReturnType<typeof readOriginTerminalReceipt> {
    return readOriginTerminalReceipt(cluster.originSockets, msgId);
}
