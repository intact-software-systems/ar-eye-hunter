import { describe, expect, it } from 'vitest';

import { createDefaultPSqlALOutboundRuntimeStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-runtime-stores.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALQosPolicyRequest } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/ws-queue-box-server-outbound-planning.ts';

import { createWorkerHold, type WorkerHold } from '../../../shared/alm/create-worker-hold.ts';
import type { SimulatedWebSocket } from '../../../shared/native-websocket-fixture.ts';
import {
    connect,
    countCopies,
    pollRowEnded,
    RECEIPT_SERVER_PEER_ID,
    serverNotification,
    sessionAck,
    toOwnReceiptRef,
    type RowEndedPoll
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
    type ReceiptTrio
} from './test-support/create-receipt-cluster.ts';
import { holdPostgresAfterCommit, holdPostgresCommit, holdPostgresCommitUntilLost } from './test-support/hold-postgres-commit.ts';
import {
    recordPostgresStatements,
    toRecordedPostgresStatementShape,
    type PostgresStatementLog
} from './test-support/record-postgres-statements.ts';

const LIFETIME_MS = 60_000;
/** An ACK timeout no case outlasts, so no `ack-timeout` window falls due inside a case that does not retry. */
const NO_WINDOW_QOS: ALQosPolicyRequest = { ack: { algo: 'receiver', opts: { timeoutMs: 20_000 } } };
/** The default 2 s ACK timeout and its retries. */
const RETRYING_QOS: ALQosPolicyRequest = { ack: { algo: 'receiver' } };
const CASE_TIMEOUT_MS = 90_000;

type OwnReceiptStore = ALOutboundAdmissionStore<WsQueueBoxServerPreparedMessage>;

/** A session of the room and the instance it is connected to. */
interface ConnectedSession {
    readonly sessionId: string;
    readonly instance: ReceiptInstance;
    readonly socket: SimulatedWebSocket;
}

/** The publication and the sessions it is admitted to. */
interface Publication {
    readonly sent: ALMessage;
    readonly sessions: readonly ConnectedSession[];
}

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL receipt of a server publication', () => {
    // Pins fifty concurrent confirmations of one publication conflicting on one row, so some are lost and the receipt
    // never completes, or ends twice.
    it('completes when fifty sessions on three instances confirm at once', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(50);
        const trio = await startTrio(cluster, sessionIds);
        const sessions = await connectSpread(trio, sessionIds);
        const sent = publication(cluster, 'fifty', NO_WINDOW_QOS);

        await publish(trio.a, { sent, sessions });
        await confirmTogether(sessions, sent);

        await expect.poll(async () => (await cluster.reader.read(toOwnReceiptRef(sent))).right?.head.phase, POLL).toBe('complete');
        await expectStoredEnd(cluster, toOwnReceiptRef(sent), {
            phase: 'complete',
            confirmedRecipientPeerIds: sessionIds,
            outsideAudienceRecipientPeerIds: []
        });
        await pollRowEnded(toRowEndedPoll(readOwnReceiptStore(cluster), sent));
        expect(await readHeadCount(cluster, sent.id.msgId)).toBe(1);
    }, CASE_TIMEOUT_MS);

    // Pins a fenced commit on the publication's version row per confirmation of it. The one move is the
    // terminal receipt's admission into the server's row.
    it('moves the publication\'s version row as often for fifty confirmations as for ten', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(50);
        const trio = await startTrio(cluster, sessionIds);
        const sessions = await connectSpread(trio, sessionIds);
        const store = readOwnReceiptStore(cluster);

        const movedForTen = await measureVersionMoves(store, trio.a, { sent: publication(cluster, 'ten', NO_WINDOW_QOS), sessions: sessions.slice(0, 10) });
        const movedForFifty = await measureVersionMoves(store, trio.a, { sent: publication(cluster, 'fifty', NO_WINDOW_QOS), sessions });

        expect(movedForFifty).toBe(movedForTen);
        expect(movedForFifty).toBe(1);
    }, CASE_TIMEOUT_MS);

    // Pins a dequeue of a server publication that names no sequence moving the server's version row, which every
    // publication and receipt the server issues would then compete for, and a sequenced one's dequeue no longer
    // fencing the track place its sender's other messages share.
    it('moves the server\'s version row once for a sequenced publication\'s dequeue, and not at all for one that names no sequence', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(2);
        const only = await startInstance(cluster, { ...instanceInput('a', sessionIds), starts: false });
        const sessions = await connectAll(only, sessionIds);
        const store = readOwnReceiptStore(cluster);
        const unsequenced = publication(cluster, 'unsequenced', NO_WINDOW_QOS);
        // The first place on a track of its own, as a client-state event states one.
        const sequenced: ALMessage = {
            ...publication(cluster, 'sequenced', NO_WINDOW_QOS),
            ordering: { orderingKey: `own-${cluster.runId}-track`, epoch: 0, seq: 1 }
        };

        const movedForUnsequenced = await measureServerVersionMoveAcrossDequeue(store, only, { sent: unsequenced, sessions });
        const movedForSequenced = await measureServerVersionMoveAcrossDequeue(store, only, { sent: sequenced, sessions });
        only.engine.start();
        await confirmTogether(sessions, unsequenced);
        await confirmTogether(sessions, sequenced);

        expect(movedForUnsequenced).toBe(0);
        expect(movedForSequenced).toBe(1);
        for (const sent of [unsequenced, sequenced]) {
            await expectStoredEnd(cluster, toOwnReceiptRef(sent), {
                phase: 'complete',
                confirmedRecipientPeerIds: sessionIds,
                outsideAudienceRecipientPeerIds: []
            });
            await pollRowEnded(toRowEndedPoll(store, sent));
        }
    }, CASE_TIMEOUT_MS);

    // Pins what one ACK of a server publication costs when its head is open and it does not complete the set: the
    // record's count alone (the head and the confirmation key in one read, the insert in one transaction, the prefix
    // read for the tally), five round trips with BEGIN and COMMIT. A client ACK's pin also holds the refusal hook's
    // reads and the inbound control-owner read; this ACK has neither, since it is addressed to the server itself
    // (no refusal hook) and names the server as its origin (the inbound runtime's origin bypass). A change that adds a
    // statement or a transaction to every such ACK shows here.
    it('counts an ACK that finds its head and does not complete the set in a pinned number of statements', async () => {
        const cluster = await createReceiptCluster();
        const log: PostgresStatementLog = { statements: [], transactions: 0 };
        const sessionIds = toSessionIds(3);
        const only = await startInstance(cluster, { ...instanceInput('a', sessionIds), log, starts: false });
        const sessions = await connectAll(only, sessionIds);
        const sent = publication(cluster, 'pin', NO_WINDOW_QOS);
        await enqueue(only, { sent, sessions });
        // A server publication's head opens only at its dequeue, which this instance's engine runs.
        await expect.poll(async () => {
            await only.engine.executeOnce();
            return (await cluster.reader.read(toOwnReceiptRef(sent))).right?.head.phase;
        }, POLL).toBe('open');
        // An instance's first inbound message runs the inbound work handler's one bootstrap batch (a finalization
        // sweep in its own transaction and a page read); s2's ACK spends it, as a client's admission does before its
        // first ACK.
        await confirmTogether(sessions.slice(2), sent);
        await waitForQuietStatements(log);
        log.statements.splice(0);
        log.transactions = 0;

        expect((await only.service.acceptIncomingMessage(sessionAck(sent, 's0', 'delivered'), 's0')).left).toBeUndefined();
        // A statement the ACK starts after it answers is pinned too, never left to race the assertion.
        await waitForQuietStatements(log);

        expect(log.transactions).toBe(1);
        expect(log.statements.map(toRecordedPostgresStatementShape)).toEqual([
            { verb: 'select', transaction: null },
            { verb: 'insert', transaction: 1 },
            { verb: 'select', transaction: null }
        ]);
        expect((await cluster.reader.read(toOwnReceiptRef(sent))).right?.tally.confirmedRecipientPeerIds).toEqual(['s0', 's2']);
    }, CASE_TIMEOUT_MS);

    // Pins what the dequeue of a receipted server publication adds for its receipt, so a change that adds a statement
    // or a transaction to every such dequeue shows here. The hook reads the server's pending receipt row through the
    // outbound store's client; on the record's client the `open` reads the head and its deadline work row, writes both
    // in one transaction and reads the view's confirmations, and the record worker's batch makes one claim, which
    // finds the deadline row not yet due and reserves nothing. That batch is the worker's first: nothing on the
    // record's client precedes it, and a fresh worker holds both lease-sweep allowances, so the batch also runs the
    // finalization sweep before its claim and the timeout sweep after it, each in its own transaction. In the steady
    // state a receipted dequeue costs 11 round trips; the sweeps' "at most once per lease" that keeps it there is
    // pinned with a controlled clock in `al-work-queue-port.test.ts` ("sweeps for timed-out leases on its first
    // claim, then at most once per lease of its own clock", "finalizes exhausted reservations on its first batch,
    // then at most once per lease of its own clock"). The hook's read follows the dispatch commit on the same client
    // with no pause between them, so it is taken while the `open` waits at its commit: the outbound client's
    // statements after its last transaction, which is the dispatch commit.
    it('opens the head at its dequeue in a pinned number of statements', async () => {
        const cluster = await createReceiptCluster();
        const outboundLog: PostgresStatementLog = { statements: [], transactions: 0 };
        const recordLog: PostgresStatementLog = { statements: [], transactions: 0 };
        const opening = createWorkerHold();
        const sessionIds = toSessionIds(3);
        const only = await startInstance(cluster, {
            ...instanceInput('a', sessionIds),
            log: outboundLog,
            toRecordSql: (sql) => recordPostgresStatements(holdPostgresCommit(sql, opening), recordLog, null),
            starts: false
        });
        const sessions = await connectAll(only, sessionIds);
        const sent = publication(cluster, 'pin', NO_WINDOW_QOS);

        await enqueue(only, { sent, sessions });
        await opening.arrived;
        await waitForQuietStatements(outboundLog);
        const afterDispatchCommit = outboundLog.statements.slice(outboundLog.statements.findLastIndex(({ transaction }) => transaction !== null) + 1);
        opening.release();
        await expect.poll(async () => (await cluster.reader.read(toOwnReceiptRef(sent))).right?.head.phase, POLL).toBe('open');
        await waitForQuietStatements(recordLog);

        // The pending receipt row, on the outbound store's client.
        expect(afterDispatchCommit.map(toRecordedPostgresStatementShape)).toEqual([{ verb: 'select', transaction: null }]);
        expect(recordLog.transactions).toBe(4);
        expect(recordLog.statements.map(toRecordedPostgresStatementShape)).toEqual([
            { verb: 'select', transaction: null }, // the head
            { verb: 'select', transaction: null }, // the deadline work row
            { verb: 'insert', transaction: 1 }, // the head, guarded
            { verb: 'insert', transaction: 1 }, // the deadline work row
            { verb: 'select', transaction: null }, // the view's confirmations
            { verb: 'select', transaction: 2 }, // the worker's first batch: the finalization sweep
            { verb: 'with', transaction: 3 }, // its claim, which finds the deadline row not yet due
            { verb: 'select', transaction: 4 } // the timeout sweep
        ]);
    }, CASE_TIMEOUT_MS);

    // Pins a retransmission that resends to every recipient, the confirmed ones included.
    it('resends inside the window only to the session that has not confirmed', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(3);
        const only = await startInstance(cluster, instanceInput('a', sessionIds));
        const sessions = await connectAll(only, sessionIds);
        const sent = publication(cluster, 'narrowed', RETRYING_QOS);
        await publish(only, { sent, sessions });

        await confirmTogether(sessions.slice(0, 2), sent);
        expect((await cluster.reader.read(toOwnReceiptRef(sent))).right?.tally.confirmedRecipientPeerIds).toEqual(['s0', 's1']);

        await expect.poll(() => readCopies(sessions, sent)[2], POLL).toBe(2);
        expect(readCopies(sessions, sent)).toEqual([1, 1, 2]);
        expect((await readOwnReceiptStore(cluster).readReceiptState(toOwnReceiptRef(sent)))?.attempts).toBeGreaterThanOrEqual(1);
    }, CASE_TIMEOUT_MS);

    // Pins a receipt that dies with the instance that dequeued its publication and opened its head.
    it('completes on the survivors when the instance that dequeued it is disposed', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(4);
        // `b` and `c` start once `a` is lost, so `a` dequeues.
        const a = await startInstance(cluster, instanceInput('a', sessionIds));
        const b = await startInstance(cluster, { ...instanceInput('b', sessionIds), starts: false });
        const c = await startInstance(cluster, { ...instanceInput('c', sessionIds), starts: false });
        const sessions = [...await connectAll(b, ['s0', 's1']), ...await connectAll(c, ['s2', 's3'])];
        const sent = publication(cluster, 'disposed', NO_WINDOW_QOS);
        await publish(a, { sent, sessions });

        await loseInstance(a);
        b.engine.start();
        c.engine.start();
        await confirmTogether(sessions, sent);

        await expectStoredEnd(cluster, toOwnReceiptRef(sent), {
            phase: 'complete',
            confirmedRecipientPeerIds: sessionIds,
            outsideAudienceRecipientPeerIds: []
        });
        await pollRowEnded(toRowEndedPoll(readOwnReceiptStore(cluster), sent));
    }, CASE_TIMEOUT_MS);

    // Pins a losing `end` that settles the server's row twice (the publication's version row moving twice) or surfaces
    // as a failure. Both counts commit before either reads its tally, so both read a complete set and both call `end`.
    it('ends once when the last two confirmations are counted at once on two instances', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(3);
        const holds = { b: createWorkerHold(), c: createWorkerHold() };
        const a = await startInstance(cluster, instanceInput('a', sessionIds));
        const b = await startInstance(cluster, {
            ...instanceInput('b', sessionIds),
            toRecordSql: (sql) => holdPostgresAfterCommit(sql, holds.b),
            starts: false
        });
        const c = await startInstance(cluster, {
            ...instanceInput('c', sessionIds),
            toRecordSql: (sql) => holdPostgresAfterCommit(sql, holds.c),
            starts: false
        });
        const sessions = [...await connectAll(a, ['s0']), ...await connectAll(b, ['s1']), ...await connectAll(c, ['s2'])];
        const sent = publication(cluster, 'both-end', NO_WINDOW_QOS);
        await publish(a, { sent, sessions });
        await confirmTogether(sessions.slice(0, 1), sent);
        const store = readOwnReceiptStore(cluster);
        const before = await readPublicationVersion(store, sent);

        const results = await countTogether([
            { hold: holds.b, count: () => b.service.acceptIncomingMessage(sessionAck(sent, 's1', 'delivered'), 's1') },
            { hold: holds.c, count: () => c.service.acceptIncomingMessage(sessionAck(sent, 's2', 'delivered'), 's2') }
        ]);

        expect(results.map((result) => result.left)).toEqual([undefined, undefined]);
        await expectStoredEnd(cluster, toOwnReceiptRef(sent), {
            phase: 'complete',
            confirmedRecipientPeerIds: sessionIds,
            outsideAudienceRecipientPeerIds: []
        });
        await pollRowEnded(toRowEndedPoll(store, sent));
        expect(await readPublicationVersion(store, sent) - before).toBe(1);
        expect(readCountOutcomes(cluster, sent.id.msgId)).toEqual<ReturnType<typeof readCountOutcomes>>(['partial', 'complete', 'complete']);
    }, CASE_TIMEOUT_MS);

    // Pins a publication whose dequeuing instance died between the dequeue commit and its head's `open`: no head is
    // ever opened, so its confirmations are never counted and the receipt waits for the row's budget.
    it('opens the head at a survivor\'s window when the instance that dequeued it was lost before its open', async () => {
        const cluster = await createReceiptCluster();
        const sessionIds = toSessionIds(3);
        const loss: HeldLoss = { hold: createWorkerHold(), lost: Promise.withResolvers<void>() };
        const a = await startInstance(cluster, {
            ...instanceInput('a', sessionIds),
            toRecordSql: (sql) => holdPostgresCommitUntilLost(sql, loss.hold, loss.lost.promise)
        });
        const b = await startInstance(cluster, { ...instanceInput('b', sessionIds), starts: false });
        // `c` stays stopped, so the window is `b`'s and its retransmission reaches the sessions connected to `b`.
        await startInstance(cluster, { ...instanceInput('c', sessionIds), starts: false });
        const sessions = await connectAll(b, sessionIds);
        const sent = publication(cluster, 'lost-open', RETRYING_QOS);
        const store = readOwnReceiptStore(cluster);

        const release = await loseInsideHeldDequeue(a, loss, { sent, sessions });
        try {
            expect((await cluster.reader.read(toOwnReceiptRef(sent))).left).toEqual({ kind: 'head-absent' });
            expect(readCopies(sessions, sent)).toEqual([0, 0, 0]);
            b.engine.start();
            await expect.poll(() => readCopies(sessions, sent).every((copies) => copies > 0), POLL).toBe(true);
            await confirmTogether(sessions, sent);

            await expectStoredEnd(cluster, toOwnReceiptRef(sent), {
                phase: 'complete',
                confirmedRecipientPeerIds: sessionIds,
                outsideAudienceRecipientPeerIds: []
            });
            expect(await readHeadCount(cluster, sent.id.msgId)).toBe(1);
            await pollRowEnded(toRowEndedPoll(store, sent));
            expect(await store.readPendingAck(toOwnReceiptRef(sent))).toBeUndefined();
            // A window charged an attempt; a second dequeue would have rewritten the row with none.
            expect((await store.readReceiptState(toOwnReceiptRef(sent)))?.attempts).toBeGreaterThanOrEqual(1);
        }
        finally {
            await release();
        }
    }, CASE_TIMEOUT_MS);
});

function toSessionIds(count: number): readonly string[] {
    return Array.from({ length: count }, (_, index) => `s${index}`);
}

/** Three started instances whose room is `sessionIds`. */
async function startTrio(cluster: ReceiptCluster, sessionIds: readonly string[]): Promise<ReceiptTrio> {
    return {
        a: await startInstance(cluster, instanceInput('a', sessionIds)),
        b: await startInstance(cluster, instanceInput('b', sessionIds)),
        c: await startInstance(cluster, instanceInput('c', sessionIds))
    };
}

/** The sessions spread over the three instances in turn, in the order of `sessionIds`. */
async function connectSpread(trio: ReceiptTrio, sessionIds: readonly string[]): Promise<readonly ConnectedSession[]> {
    return await Promise.all(sessionIds.map(async (sessionId, index) => {
        const instance = index % 3 === 0 ? trio.a : index % 3 === 1 ? trio.b : trio.c;
        return { sessionId, instance, socket: await connect(instance, sessionId) };
    }));
}

async function connectAll(instance: ReceiptInstance, sessionIds: readonly string[]): Promise<readonly ConnectedSession[]> {
    return await Promise.all(sessionIds.map(async (sessionId) => ({ sessionId, instance, socket: await connect(instance, sessionId) })));
}

/** A room broadcast of the instances' shared server name; its message id carries the run id. */
function publication(cluster: ReceiptCluster, name: string, qos: ALQosPolicyRequest): ALMessage {
    return {
        ...serverNotification(`own-${cluster.runId}-${name}`, 'receiver', LIFETIME_MS),
        delivery: { reliability: 'at-least-once', ack: 'receiver' },
        qos
    };
}

/** The router's enqueue: the committed policy expects nobody, and the dequeue's pending row expects the sessions. */
async function enqueue(instance: ReceiptInstance, { sent, sessions }: Publication): Promise<void> {
    const admittedAudience = sessions.map(({ sessionId }) => sessionId);
    const result = await instance.service.enqueueOutboxIfAbsent(sent, {
        admittedAudience,
        admittedConnectionGenerationIds: undefined,
        recipientScope: undefined
    });
    expect(result.verdict.kind).toBe('admitted');
}

/**
 * Enqueues on `instance` and waits until every session holds the dequeue's copy, which the dequeue hook publishes
 * after the head's `open`.
 */
async function publish(instance: ReceiptInstance, publication: Publication): Promise<void> {
    await enqueue(instance, publication);
    await expect.poll(() => readCopies(publication.sessions, publication.sent), POLL).toEqual(publication.sessions.map(() => 1));
}

function readCopies(sessions: readonly ConnectedSession[], sent: ALMessage): readonly number[] {
    return sessions.map(({ socket }) => countCopies(socket, sent.id.msgId));
}

/** The hold an instance's record transactions stop at, and the loss their callers wait for once stopped there. */
interface HeldLoss {
    readonly hold: WorkerHold;
    readonly lost: PromiseWithResolvers<void>;
}

/**
 * Enqueues on `instance`, whose record client is `holdPostgresCommitUntilLost`'s at `loss`, and once its dequeue's `open` is written
 * and uncommitted loses the instance: its engine claims nothing more and its record client is terminated, so
 * PostgreSQL rolls the `open` back, and the dequeue waits at the loss, so no copy leaves the instance. Disposing the
 * instance would wait for that dequeue, so it is not disposed here. The returned release lets the dequeue run out once
 * the case has asserted; what it then does is the lost instance's own.
 */
async function loseInsideHeldDequeue(instance: ReceiptInstance, loss: HeldLoss, publication: Publication): Promise<() => Promise<void>> {
    let arrived = false;
    void loss.hold.arrived.then(() => {
        arrived = true;
    });
    await enqueue(instance, publication);
    await expect.poll(() => arrived, POLL).toBe(true);
    const stopping = instance.engine.stop();
    await instance.recordClient.terminate();
    return async () => {
        loss.hold.release();
        loss.lost.resolve();
        await Promise.allSettled([stopping]);
    };
}

/** Every session's ACK, accepted at once on the instance it is connected to. */
async function confirmTogether(sessions: readonly ConnectedSession[], sent: ALMessage): Promise<void> {
    const results = await Promise.all(
        sessions.map(async ({ sessionId, instance }) => await instance.service.acceptIncomingMessage(sessionAck(sent, sessionId, 'delivered'), sessionId))
    );
    expect(results.map((result) => result.left)).toEqual(sessions.map(() => undefined));
}

/**
 * How often the publication's version row moved from the settled dequeue until the head ended and its terminal receipt
 * settled the server's row.
 */
async function measureVersionMoves(store: OwnReceiptStore, instance: ReceiptInstance, publication: Publication): Promise<number> {
    const { sent, sessions } = publication;
    await publish(instance, publication);
    const before = await readPublicationVersion(store, sent);
    await confirmTogether(sessions, sent);
    await pollRowEnded(toRowEndedPoll(store, sent));
    return await readPublicationVersion(store, sent) - before;
}

/**
 * How often the server's own version row moved across the publication's dequeue: read once its enqueue committed and
 * again once every session holds the dequeue's copy, with the instance's engine passes the only work run between.
 */
async function measureServerVersionMoveAcrossDequeue(store: OwnReceiptStore, instance: ReceiptInstance, publication: Publication): Promise<number> {
    const { sent, sessions } = publication;
    await enqueue(instance, publication);
    const before = await readServerVersion(store, sent);
    await expect.poll(async () => {
        await instance.engine.executeOnce();
        return readCopies(sessions, sent);
    }, POLL).toEqual(sessions.map(() => 1));
    return await readServerVersion(store, sent) - before;
}

/** The server's sender version; a row no commit wrote is version 0. */
async function readServerVersion(store: OwnReceiptStore, sent: ALMessage): Promise<number> {
    const read = { msgId: sent.id.msgId, originPeerId: RECEIPT_SERVER_PEER_ID, phase: 'admitted', expectedRecipientPeerIds: [] } as const;
    return (await store.readReceiptAdmission(read)).clientRecord?.version ?? 0;
}

async function readPublicationVersion(store: OwnReceiptStore, sent: ALMessage): Promise<number> {
    const read = { msgId: sent.id.msgId, originPeerId: RECEIPT_SERVER_PEER_ID, phase: 'admitted', expectedRecipientPeerIds: [] } as const;
    const version = (await store.readReceiptAdmission(read)).messageVersion?.version;
    if (version === undefined) {
        throw new Error('The publication has no version row');
    }
    return version;
}

/** The instances run their own work, so each poll only reads the row. */
function toRowEndedPoll(store: OwnReceiptStore, sent: ALMessage): RowEndedPoll {
    return { store, msgId: sent.id.msgId, advance: async () => {}, timeoutMs: POLL.timeout };
}

/** The server's outbound admission state, read through the client no instance uses. */
function readOwnReceiptStore(cluster: ReceiptCluster): OwnReceiptStore {
    return createDefaultPSqlALOutboundRuntimeStores({
        repository: new PSqlRuntimeStateRepository(cluster.readerClient),
        namespace: cluster.storeId,
        decodePrepared: decodeWsQueueBoxServerPreparedMessage
    }).admissionStore;
}
