import { describe, expect, it, onTestFinished } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import {
    createDefaultPSqlALInboundRuntimeStores,
    createDefaultPSqlALOutboundRuntimeStores
} from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_CONTROL_RECEIPT_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALReceiptPayload } from '@shared/al-contracts/al-control-value-codec.ts';
import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALReceiptRecordHeadKey, type ALReceiptRecordRef } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';
import { AL_WORK_READINESS_MEMORY_MS } from '@shared/alm/work/al-work-handler.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';

import type { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    connect,
    createBridgeBus,
    createClusterInstance,
    RECEIPT_SERVER_PEER_ID,
    receiverAck,
    roomMessage,
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
import { racePastHeldCommit } from './test-support/race-past-held-commit.ts';
import {
    recordPostgresStatements,
    toRecordedPostgresStatementShape,
    type PostgresStatementLog
} from './test-support/record-postgres-statements.ts';

const ORIGIN = 'o';
const ROOM = ['o', 'r1', 'r2'];
const LIFETIME_MS = 30_000;
/** A deadline the survivors' engines reach in real time: the PostgreSQL queue calls work due on the database clock. */
const DEADLINE_LIFETIME_MS = 2_000;
const POLL = { timeout: 20_000 } as const;
const CASE_TIMEOUT_MS = 60_000;

/** One run: its rows carry `runId`, its instances share one store id, one bus and the test's own reader of the record. */
interface ReceiptCluster {
    readonly runId: string;
    readonly storeId: string;
    readonly clients: TerminablePostgresSql[];
    readonly bus: ReturnType<typeof createBridgeBus>;
    readonly originSockets: SimulatedWebSocket[];
    /** Reads the record every instance writes, through a client no instance uses. */
    readonly reader: ALReceiptRecord;
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

interface SentReceipt {
    readonly controlId: string;
    readonly receipt: ALReceiptPayload;
}

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

        const completeOnB = () => readReceipts([onB], msgId).filter(({ receipt }) => receipt.phase === 'complete');
        await expect.poll(() => completeOnB().length, POLL).toBe(1);
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
        const onB = await connectOrigin(cluster, b);

        await expect.poll(() => readReceipts([onB], msgId).map(({ receipt }) => receipt.phase), POLL).toEqual(['timed-out']);
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
        const [ended, again] = readOriginReceipts(cluster, msgId).filter(({ receipt }) => receipt.phase === 'complete');
        expect(again!.controlId).not.toBe(ended!.controlId);
        expect(toSets(again!.receipt)).toEqual(toSets(ended!.receipt));
    }, CASE_TIMEOUT_MS);

    // Pins a receipt never started when the admitting instance died between its admission's commit and its `open`.
    it('opens the record from a re-sent copy when the admitting instance was lost between its admission and its open', async () => {
        const cluster = await createReceiptCluster();
        const hold = createWorkerHold();
        const a = await startInstance(cluster, { ...instanceInput('a', ROOM), recordHold: hold, starts: false });
        const { b, c } = await startTwo(cluster);
        const msgId = toMsgId(cluster, 'lost-open');
        const sent = message(msgId, LIFETIME_MS);
        await connectOrigin(cluster, a);
        // The admission commits; its `open` is written, held uncommitted, and rolled back when its client is lost.
        a.service.acceptIncomingMessage(sent, ORIGIN).catch(() => undefined);
        await hold.arrived;
        await loseInstance(a);
        await a.recordClient.terminate();
        hold.release();

        expect((await b.service.acceptIncomingMessage(ackOf(msgId, 'r1'), 'r1')).left).toBeUndefined();
        expect((await c.service.acceptIncomingMessage(ackOf(msgId, 'r2'), 'r2')).left).toBeUndefined();
        await connectOrigin(cluster, b);
        expect((await b.service.acceptIncomingMessage(sent, ORIGIN)).right).toEqual({ kind: 'duplicate' });

        await expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'complete']);
        const [admitted, complete] = readOriginReceipts(cluster, msgId);
        expect(admitted!.receipt.expectedRecipientPeerIds).toEqual(['r1', 'r2']);
        expect(complete!.receipt.confirmedRecipientPeerIds).toEqual(['r1', 'r2']);
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
            startRaced: () => expect.poll(() => phases(cluster, msgId), POLL).toEqual(['admitted', 'timed-out']),
            blockedAfterMs: POLL.timeout
        });

        expect(race.raced).toBe('finished');
        expect(race.heldResult.left).toBeUndefined();
        await new Promise((resolve) => setTimeout(resolve, AL_WORK_READINESS_MEMORY_MS + 500));
        expect(phases(cluster, msgId)).toEqual(['admitted', 'timed-out']);
        expect(terminal(cluster, msgId)).toMatchObject({ confirmedRecipientPeerIds: ['r1'] });
        const stored = (await cluster.reader.read(toRef(msgId))).right?.head;
        expect(stored).toMatchObject({ phase: 'timed-out', confirmedRecipientPeerIds: ['r1'] });
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
    return { a, ...await startTwo(cluster) };
}

/** Two started instances of the room, `r1` connected to `b` and `r2` to `c`. */
async function startTwo(cluster: ReceiptCluster): Promise<Omit<ReceiptTrio, 'a'>> {
    const b = await startInstance(cluster, instanceInput('b', ROOM));
    const c = await startInstance(cluster, instanceInput('c', ROOM));
    await connect(b, 'r1');
    await connect(c, 'r2');
    return { b, c };
}

/** An instance lost as a process is: its service disposed and its engine stopped, its sockets left as they were. */
async function loseInstance(instance: ClusterInstance): Promise<void> {
    await instance.service.dispose();
    await instance.engine.stop();
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

/** The admission's own outbound batches run after it answers: they have settled once a quarter second passes without one. */
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

function readReceipts(sockets: readonly SimulatedWebSocket[], msgId: string): readonly SentReceipt[] {
    return sockets.flatMap((socket) =>
        socket.sent
            .map((frame) => decodePersistedALMessage(frame))
            .filter((control) => control.payload.typeId === AL_CONTROL_RECEIPT_TYPE_ID)
            .map((control) => ({ controlId: control.id.msgId, receipt: decodeALReceiptPayload(JSON.parse(control.payload.resource)) }))
            .filter(({ receipt }) => receipt.msgId === msgId)
    );
}

/** The origin's receipts for the message, each once whichever of its sockets carried it, in the order observed. */
function readOriginReceipts(cluster: ReceiptCluster, msgId: string): readonly SentReceipt[] {
    const unique = new Map(readReceipts(cluster.originSockets, msgId).map((sent) => [sent.controlId, sent]));
    const toOrder = ({ receipt }: SentReceipt) => [receipt.observedAtEpochMs, receipt.phase === 'admitted' ? 0 : 1] as const;
    return [...unique.values()].sort((left, right) => {
        const [leftAtMs, leftRank] = toOrder(left);
        const [rightAtMs, rightRank] = toOrder(right);
        return leftAtMs - rightAtMs || leftRank - rightRank;
    });
}

function phases(cluster: ReceiptCluster, msgId: string): readonly ALReceiptPayload['phase'][] {
    return readOriginReceipts(cluster, msgId).map(({ receipt }) => receipt.phase);
}

function terminal(cluster: ReceiptCluster, msgId: string): ALReceiptPayload | undefined {
    return readOriginReceipts(cluster, msgId).find(({ receipt }) => receipt.phase !== 'admitted')?.receipt;
}

function toSets(
    receipt: ALReceiptPayload
): Pick<ALReceiptPayload, 'expectedRecipientPeerIds' | 'confirmedRecipientPeerIds' | 'outsideAudienceRecipientPeerIds'> {
    const { expectedRecipientPeerIds, confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds } = receipt;
    return { expectedRecipientPeerIds, confirmedRecipientPeerIds, outsideAudienceRecipientPeerIds };
}
