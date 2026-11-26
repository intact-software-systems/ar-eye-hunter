import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOutboundOriginMessageKey, toALOutboundVersionKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import type { ALReceiptRecordRef } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { toWsQueueBoxServerEndedReceiptControlId } from '@shared/services/ws-queue-box-server/receipt/to-ws-queue-box-server-receipt-control.ts';
import type { WsQueueBoxServerReceiptOutboxVerdict } from '@shared/services/ws-queue-box-server/ws-queue-box-server-receipt-observation.ts';

import { createWorkerHold, type WorkerHold } from '../../../shared/alm/create-worker-hold.ts';
import type { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    connect,
    readOriginReceiptPhases,
    readOriginReceipts,
    readOriginTerminalReceipt,
    readReceiptAggregationVerdicts,
    readTerminalReceiptIdentities,
    RECEIPT_SERVER_PEER_ID,
    receiverAck,
    roomMessage,
    toReceiptSets,
    type ClusterInstance,
    type ReceiptAggregationVerdict
} from '../../../shared/services/ws-queue-box-server-receipt-fixture.ts';
import {
    countTogether,
    createReceiptCluster,
    expectStoredEnd,
    instanceInput,
    loseInstance,
    POLL,
    readCountOutcomes,
    readHeadCount,
    startInstance,
    waitForQuietStatements,
    type ReceiptCluster,
    type ReceiptInstance,
    type ReceiptTrio,
    type StartAcceptance
} from './test-support/create-receipt-cluster.ts';
import { holdPostgresAfterCommit, holdPostgresCommit } from './test-support/hold-postgres-commit.ts';
import { awaitHoldArrival, racePastHeldCommit } from './test-support/race-past-held-commit.ts';
import {
    toRecordedPostgresStatementShape,
    type PostgresStatementLog,
    type RecordedPostgresStatement
} from './test-support/record-postgres-statements.ts';

const ORIGIN = 'o';
const ROOM = ['o', 'r1', 'r2'];
/** A room view wider than `ROOM`: a receipt that expects `r3` was opened from this view, not from the admission row. */
const WIDER_ROOM = [...ROOM, 'r3'];
const LIFETIME_MS = 30_000;
/** A deadline the survivors' engines reach in real time: the PostgreSQL queue calls work due on the database clock. */
const DEADLINE_LIFETIME_MS = 2_000;
const CASE_TIMEOUT_MS = 60_000;

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL WS receipt record across instances', () => {
    // Pins an instance that counts on a record of its own: the receipt never completes, and the shared record holds
    // no ended head.
    it('completes a receipt admitted on one instance and confirmed on two others', async () => {
        const cluster = await createReceiptCluster();
        const { msgId } = await completeOneReceipt(cluster, await startThree(cluster), 'complete');

        expect(phases(cluster, msgId)).toEqual(['admitted', 'complete']);
        expect(terminal(cluster, msgId)).toMatchObject({ confirmedRecipientPeerIds: ['r1', 'r2'] });
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'], outsideAudienceRecipientPeerIds: [] });
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

        await expect.poll(() => readOriginReceiptPhases([onB], msgId), POLL).toEqual(['complete']);
        expect(readOriginTerminalReceipt([onB], msgId)?.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
        expect(readTerminalReceiptIdentities([onB], msgId)).toHaveLength(1);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'], outsideAudienceRecipientPeerIds: [] });
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

        await expect.poll(() => readOriginReceiptPhases([onB], msgId), POLL).toEqual(['timed-out']);
        expect(phases(cluster, msgId)).toEqual(['admitted', 'timed-out']);
        expect(terminal(cluster, msgId)).toMatchObject({ expectedRecipientPeerIds: ['r1', 'r2'], confirmedRecipientPeerIds: ['r1'] });
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'timed-out', confirmedRecipientPeerIds: ['r1'], outsideAudienceRecipientPeerIds: [] });
    }, CASE_TIMEOUT_MS);

    // Pins a copy re-sent to another instance after the end going unanswered, or answered under the ended control id.
    it('answers a re-sent copy on another instance after the end with the terminal receipt', async () => {
        const cluster = await createReceiptCluster();
        const trio = await startThree(cluster);
        await connectOrigin(cluster, trio.c);
        const { msgId, sent } = await completeOneReceipt(cluster, trio, 'resent');

        expect((await trio.c.service.acceptIncomingMessage(sent, ORIGIN)).right).toEqual({ kind: 'duplicate' });

        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete', 'complete']);
        const [ended, again] = readOriginReceipts(cluster.originSockets, msgId).filter(({ receipt }) => receipt.phase === 'complete');
        expect(again!.controlId).not.toBe(ended!.controlId);
        expect(toReceiptSets(again!.receipt)).toEqual(toReceiptSets(ended!.receipt));
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'], outsideAudienceRecipientPeerIds: [] });
    }, CASE_TIMEOUT_MS);

    // Pins a receipt never started when the admitting instance died between its admission's commit and its `open`, and
    // a survivor opening it from its own view of the room instead of the audience the admission row froze: the
    // survivors' view holds `r3`, the admitting instance's did not.
    it('opens the record from a re-sent copy when the admitting instance was lost between its admission and its open', async () => {
        const cluster = await createReceiptCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), toRecordSql: (sql) => holdPostgresCommit(sql, hold), starts: false });
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
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
        expect(await readHeadCount(cluster, msgId)).toBe(1);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'], outsideAudienceRecipientPeerIds: [] });
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
        expect(terminal(cluster, msgId)).toMatchObject({ expectedRecipientPeerIds: ['leader'] });
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['leader'], outsideAudienceRecipientPeerIds: [] });
    }, CASE_TIMEOUT_MS);

    // Memory serialises writes and cannot hold a count that read an open head until after another instance's `end`:
    // pins that late confirmation turning the ended receipt complete, joining its sets, or answering it twice.
    it('keeps the deadline end of a receipt whose last count commits after it', async () => {
        const cluster = await createReceiptCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const b = await startInstance(cluster, { ...instanceInput('b', ROOM), toRecordSql: (sql) => holdPostgresCommit(sql, hold), starts: false });
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
        expect(terminal(cluster, msgId)).toMatchObject({ confirmedRecipientPeerIds: ['r1'] });
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
        // Read after the held count returned: its late confirmation is not in the ended head.
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'timed-out', confirmedRecipientPeerIds: ['r1'], outsideAudienceRecipientPeerIds: [] });
    }, CASE_TIMEOUT_MS);

    // Pins a losing `end` that delivers a second terminal receipt or surfaces as a failure. Both counts commit before
    // either reads its tally, so both read a complete set and both call `end`, as the memory case "a losing end is
    // silent" arranges with its view gate.
    it('delivers one complete receipt when the last two ACKs are counted at once on two instances', async () => {
        const cluster = await createReceiptCluster();
        const holds = { b: createWorkerHold(), c: createWorkerHold() };
        const a = await startInstance(cluster, instanceInput('a', ROOM));
        const b = await startInstance(cluster, { ...instanceInput('b', ROOM), toRecordSql: (sql) => holdPostgresAfterCommit(sql, holds.b), starts: false });
        const c = await startInstance(cluster, { ...instanceInput('c', ROOM), toRecordSql: (sql) => holdPostgresAfterCommit(sql, holds.c), starts: false });
        await connect(b, 'r1');
        await connect(c, 'r2');
        const msgId = toMsgId(cluster, 'both-end');
        await connectOrigin(cluster, a);
        await a.service.acceptIncomingMessage(message(msgId, LIFETIME_MS), ORIGIN);

        const results = await countTogether([
            { hold: holds.b, count: () => b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1') },
            { hold: holds.c, count: () => c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2') }
        ]);

        expect(results.map((result) => result.left)).toEqual([undefined, undefined]);
        expect(readCountOutcomes(cluster, msgId)).toEqual<ReturnType<typeof readCountOutcomes>>(['complete', 'complete']);
        await expectStoredEnd(cluster, toRef(msgId), { phase: 'complete', confirmedRecipientPeerIds: ['r1', 'r2'], outsideAudienceRecipientPeerIds: [] });
        expect(readCompleteOutboxVerdicts(cluster, msgId)).toEqual<ReturnType<typeof readCompleteOutboxVerdicts>>(['admitted']);
        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete']);
        // The losing `end` records no refusal, no further count and no failed receipt.
        expect(readReceiptAggregationVerdicts(cluster.observations, msgId)).toEqual<readonly ReceiptAggregationVerdict[]>([
            'ack-count:complete',
            'ack-count:complete',
            'receipt-outbox:admitted:admitted',
            'receipt-outbox:complete:admitted'
        ]);
        expect(readTerminalReceiptIdentities(cluster.originSockets, msgId)).toHaveLength(1);
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

    // Pins a terminal receipt control whose enqueue or dequeue fences the server's own version row, which every
    // receipt the server issues would then compete for, or which costs either commit another statement. The decision
    // still reads that row: its read rides the batched autocommit statement before the enqueue's transaction.
    it('enqueues and dequeues a terminal receipt control in a pinned list of statements, none on the server\'s version row', async () => {
        const cluster = await createReceiptCluster();
        const log: PostgresStatementLog = { statements: [], transactions: 0 };
        const only = await startInstance(cluster, { ...instanceInput('a', ROOM), log, starts: false });
        await connect(only, 'r1');
        await connect(only, 'r2');
        const msgId = toMsgId(cluster, 'ended-control');
        await connectOrigin(cluster, only);
        expect((await only.service.acceptIncomingMessage(message(msgId, LIFETIME_MS), ORIGIN)).right?.kind).toBe('admitted');
        expect((await only.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        expect((await only.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2')).left).toBeUndefined();

        await expect.poll(async () => {
            await only.engine.executeOnce();
            return phases(cluster, msgId);
        }, POLL).toEqual(['admitted', 'complete']);
        await waitForQuietStatements(log);

        const { namespace } = only.outboundAdmissionStore;
        const controlVersionKey = toALOutboundOriginMessageKey({
            row: 'msg-version',
            namespace,
            originPeerId: RECEIPT_SERVER_PEER_ID,
            msgId: toWsQueueBoxServerEndedReceiptControlId(toRef(msgId))
        });
        const serverVersionKey = toALOutboundVersionKey(namespace, RECEIPT_SERVER_PEER_ID);
        const controlTransactions = readTransactionsNaming(log, controlVersionKey);
        expect(controlTransactions).toHaveLength(2);
        const [enqueue, dequeue] = controlTransactions;
        expect(readTransactionVerbs(log, enqueue)).toEqual([
            { verb: 'with' }, // the guarded batch on the control's version row
            { verb: 'insert' } // the work row
        ]);
        expect(readTransactionVerbs(log, dequeue)).toEqual([
            { verb: 'with' }, // the guarded batch on the control's version row
            { verb: 'select' }, // the hold of the claimed row
            { verb: 'insert' } // the work row
        ]);
        expect(log.statements.filter(({ transaction, values }) => transaction !== null && namesKey(values, serverVersionKey))).toEqual([]);
        const enqueueStart = log.statements.findIndex(({ transaction }) => transaction === enqueue);
        expect(log.statements.slice(0, enqueueStart).some(({ transaction, values }) => transaction === null && namesKey(values, serverVersionKey))).toBe(true);
    }, CASE_TIMEOUT_MS);
});

/** The recorded transactions, in order, that hold a statement naming `key`; a key can sit inside a JSON-encoded parameter. */
function readTransactionsNaming(log: PostgresStatementLog, key: string): readonly number[] {
    const transactions = log.statements.flatMap(({ transaction, values }) => transaction !== null && namesKey(values, key) ? [transaction] : []);
    return [...new Set(transactions)];
}

function readTransactionVerbs(log: PostgresStatementLog, transaction: number | undefined): readonly Readonly<{ verb: string; }>[] {
    return log.statements.filter((statement) => statement.transaction === transaction).map((statement) => ({
        verb: toRecordedPostgresStatementShape(statement).verb
    }));
}

/** Whether the encoded values name `key` as a parameter, or inside a parameter that is itself JSON-encoded. */
function namesKey(values: RecordedPostgresStatement['values'], key: string): boolean {
    const encoded = JSON.stringify(values, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    const asParameter = JSON.stringify(key).slice(1, -1);
    return encoded.includes(asParameter) || encoded.includes(JSON.stringify(asParameter).slice(1, -1));
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

/** The outbox verdict of each `complete` receipt the instances wrote for the message. */
function readCompleteOutboxVerdicts(cluster: ReceiptCluster, msgId: string): readonly WsQueueBoxServerReceiptOutboxVerdict['kind'][] {
    return cluster.observations.flatMap((observation) =>
        observation.kind === 'receipt-outbox' && observation.receipt.msgId === msgId && observation.receipt.phase === 'complete'
            ? [observation.verdict.kind]
            : []
    );
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

function phases(cluster: ReceiptCluster, msgId: string): ReturnType<typeof readOriginReceiptPhases> {
    return readOriginReceiptPhases(cluster.originSockets, msgId);
}

function terminal(cluster: ReceiptCluster, msgId: string): ReturnType<typeof readOriginTerminalReceipt> {
    return readOriginTerminalReceipt(cluster.originSockets, msgId);
}
