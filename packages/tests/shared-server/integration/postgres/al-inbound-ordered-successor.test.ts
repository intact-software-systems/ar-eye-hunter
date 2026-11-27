import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { toALInboundLocalDeliveryEffectId } from '@shared/alm/inbound/al-inbound-effect-intent.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { toALInboundWorkKey } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import { createWorkerHold, type WorkerHold } from '../../../shared/alm/create-worker-hold.ts';
import {
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE,
    type InboundTestRuntime
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    admitPostgresInboundTestMessage,
    createPostgresInboundRuntimeStores
} from './test-support/create-postgres-inbound-admission-store.ts';
import { createPostgresSqlCall } from './test-support/create-postgres-sql-call.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import {
    recordPostgresStatements,
    toRecordedPostgresStatementShape,
    type PostgresStatementLog,
    type RecordedPostgresStatement,
    type RecordedPostgresStatementShape
} from './test-support/record-postgres-statements.ts';

type EffectDrain = Extract<ALInboundRuntimeDiagnosticsEvent, { kind: 'effect-drain'; }>;
type ReservationHoldPoint = 'before-locked-read' | 'after-locked-read';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;
const RUN_ID = `al-inbound-ordered-successor-${crypto.randomUUID()}`;
const TRACK_KEY = toALOrderingTrackKey(createInboundTestMessage({ msgId: 'track', seq: 1 }))!;
const LOCKED_RESERVATION_READ = 'for update of candidate skip locked';

describe('Postgres hand-on of an ordered successor across two instances', () => {
    let instanceA: PostgresSql | undefined;
    let instanceB: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            instanceA = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            instanceB = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (instanceA !== undefined && instanceB !== undefined) {
            try {
                await deletePostgresRunRows(instanceA, RUN_ID);
                expect(await readPostgresRunRowCounts(instanceA, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await instanceA.end();
                await instanceB.end();
            }
        }
    });

    // Pins the hand-on across instances: the successor B's admission wrote, which B's own round read and found behind its
    // undelivered predecessor, waited for the rotation after A completed that predecessor; A's batch now delivers it,
    // once, in order.
    postgresIt('delivers in the completing instance\'s batch a successor another instance admitted', async () => {
        const namespace = `${RUN_ID}-across`;
        const hold = createDispatchHold(1);
        const a = createInstance({ sql: instanceA!, namespace, instance: 'a', gateDispatch: hold.gate });
        const logB = createStatementLog();
        const b = createInstance({ sql: recordPostgresStatements(instanceB!, logB, null), namespace, instance: 'b' });
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(b.stores.admissionStore, second);
        clearStatementLog(logB);
        expect(await b.queueEngine.executeOnce()).toBe(false);
        expect(logB.statements.map((statement) => toNamedStatementShape(statement, namespace)))
            .toEqual(toProbeBehindPredecessor(second, first));
        expect(readReceived(b)).toEqual([]);
        expect(await readWorkRow(b, second)).toEqual({ status: EntityStatus.NEW, attempts: 0 });

        hold.release();
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);

        expect(readReceived(a)).toEqual(['m-1', 'm-2']);
        expect(readReceived(b)).toEqual([]);
        expect(readDrainsNaming(a, first)[0]).toMatchObject({
            claimedEffectIds: [toDispatchId(first), toDispatchId(second)],
            claimedCount: 2,
            promoted: 1
        });
        expect(await readWorkRow(a, second)).toEqual({ status: EntityStatus.COMPLETED, attempts: 1 });
        expect((await a.stores.admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
    });

    // Pins one reservation per row when both instances reach for the successor: A's hand-on is held at its locked read
    // while B's rotation comes round to the row. Held before that read, B reserves the row and A's read finds it taken;
    // held after it, A holds the row's lock and B's read skips it. Either way one instance delivers it, and the other's
    // reservation returns no row, and no statement of its log after that point writes the row, by its key or its id.
    postgresIt.each([
        { at: 'before-locked-read' as const, winner: 'b' as const },
        { at: 'after-locked-read' as const, winner: 'a' as const }
    ])('delivers the successor once when both instances reach for it, held $at', async ({ at, winner }) => {
        const namespace = `${RUN_ID}-race-${at}`;
        const [logA, logB] = [createStatementLog(), createStatementLog()];
        const hold = createDispatchHold(1);
        const reservation = createReservationHold();
        const a = createInstance({
            sql: holdPostgresReservation(recordPostgresStatements(instanceA!, logA, null), reservation),
            namespace,
            instance: 'a',
            gateDispatch: hold.gate
        });
        const b = createInstance({ sql: recordPostgresStatements(instanceB!, logB, null), namespace, instance: 'b' });
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(b.stores.admissionStore, second);
        clearStatementLog(logB);
        expect(await b.queueEngine.executeOnce()).toBe(false);
        expect(logB.statements.map((statement) => toNamedStatementShape(statement, namespace)))
            .toEqual(toProbeBehindPredecessor(second, first));
        expect(await readWorkRow(b, second)).toEqual({ status: EntityStatus.NEW, attempts: 0 });
        const rowId = await readWorkRowId(b, second);

        const held = reservation.arm(at);
        hold.release();
        // A's batch either reaches its hand-on's locked read or ends without one; only the first is the hand-on.
        expect(
            await Promise.race([
                held.arrived.then(() => 'held at the hand-on\'s reservation'),
                waitForDrainNaming(a, first).then(() => 'drained without a hand-on reservation')
            ])
        ).toBe('held at the hand-on\'s reservation');
        logB.statements.length = 0;
        await expect.poll(async () => {
            await b.queueEngine.executeOnce();
            return readLockedReads(logB, rowId).length;
        }).toBeGreaterThan(0);
        const reachedAt = logA.statements.length;
        held.release();
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);
        await expect.poll(() => [...readDrainsNaming(a, second), ...readDrainsNaming(b, second)]).toHaveLength(1);

        const [winning, losing] = winner === 'a' ? [a, b] : [b, a];
        expect(readReceived(winning)).toEqual(winner === 'a' ? ['m-1', 'm-2'] : ['m-2']);
        expect(readReceived(losing)).toEqual(winner === 'a' ? [] : ['m-1']);
        expect(readDrainsNaming(a, first)[0]!.promoted).toBe(winner === 'a' ? 1 : 0);
        const losingLog = winner === 'a' ? logB : { statements: logA.statements.slice(reachedAt), transactions: 0 };
        expect(readLockedReads(losingLog, rowId).map((statement) => statement.rowCount)).toSatisfy(isAllZero);
        expect(readWritesOfRow(losingLog, { key: toEncodedDispatchId(second), rowId }).map(toRecordedPostgresStatementShape)).toEqual([]);
        expect(await readWorkRow(a, second)).toEqual({ status: EntityStatus.COMPLETED, attempts: 1 });
        expect((await a.stores.admissionStore.readOrderedDelivery(TRACK_KEY, 3)).completedThrough).toBe(2);
    });
});

describe('Postgres statements of an ordered completion', () => {
    let instanceA: PostgresSql | undefined;

    beforeAll(async () => {
        if (process.env.RALLAR_POSTGRES_INTEGRATION === '1') {
            instanceA = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
        }
    });

    afterAll(async () => {
        if (instanceA !== undefined) {
            try {
                await deletePostgresRunRows(instanceA, RUN_ID);
                expect(await readPostgresRunRowCounts(instanceA, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await instanceA.end();
            }
        }
    });

    // Pins the price of the lookup when nothing waits: one autocommit read of the next slot, and no work row read or
    // written but the batch's own release.
    postgresIt('costs one slot read when nothing waits behind it', async () => {
        const namespace = `${RUN_ID}-alone`;
        const log = createStatementLog();
        const hold = createDispatchHold(1);
        const a = createInstance({ sql: recordPostgresStatements(instanceA!, log, null), namespace, instance: 'a', gateDispatch: hold.gate });
        const first = toMessage(1);
        await admit(a, first);
        await hold.entered;

        clearStatementLog(log);
        hold.release();
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);

        expect(log.statements.filter((statement) => statement.text.includes('resource_inbox')).map(toRecordedPostgresStatementShape))
            .toEqual([{ verb: 'update', transaction: 2 }]);
        expect(log.statements.map((statement) => toNamedStatementShape(statement, namespace))).toEqual([
            ...toCompletionReads(first),
            { verb: 'with', transaction: 1 },
            toAutocommitRead(toSlotKey(2)),
            // The batch's release.
            { verb: 'update', transaction: 2 }
        ]);
    });

    // Pins the price of a hand-on, beside the rotation's claim of the same kind of row below: the slot read and the row
    // read, then the readiness reads and the reservation the rotation spends too, and the delivery's own surface read
    // again (the message, its owner row, the progress) where the rotation's delivery reads only the progress.
    postgresIt('costs a hand-on its slot read, its row read and a second read of its message and owner row', async () => {
        const namespace = `${RUN_ID}-hand-on`;
        const log = createStatementLog();
        const hold = createDispatchHold(1);
        const a = createInstance({ sql: recordPostgresStatements(instanceA!, log, null), namespace, instance: 'a', gateDispatch: hold.gate });
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(a.stores.admissionStore, second);

        clearStatementLog(log);
        hold.release();
        await expect.poll(() => readDrainsNaming(a, second)).toHaveLength(1);

        expect(readReceived(a)).toEqual(['m-1', 'm-2']);
        expect(log.statements.map((statement) => toNamedStatementShape(statement, namespace))).toEqual([
            ...toCompletionReads(first),
            { verb: 'with', transaction: 1 },
            ...toHandOnClaim(second),
            // The second delivery: its own surface, read again, its completion, the read of the slot after it, then the
            // batch's release of both rows.
            ...toReadinessReads(second),
            ...toCompletionReads(second),
            { verb: 'with', transaction: 3 },
            toAutocommitRead(toSlotKey(3)),
            { verb: 'update', transaction: 4 }
        ]);
    });

    // Pins the rotation's price for the same kind of row, beside the hand-on's above: the page read, the read of rows out
    // of attempts and the lease-timeout read serve the whole batch; on the row it spends the readiness reads and the
    // reservation, and its delivery reads only the progress, carrying the message it read with the page. No slot read
    // and no row read.
    postgresIt('claims through the rotation a successor whose predecessor completed, at its readiness reads and reservation', async () => {
        const namespace = `${RUN_ID}-rotation`;
        const log = createStatementLog();
        const a = createInstance({ sql: instanceA!, namespace, instance: 'a' });
        const b = createInstance({ sql: recordPostgresStatements(instanceA!, log, null), namespace, instance: 'b' });
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);
        await admitPostgresInboundTestMessage(a.stores.admissionStore, second);

        await b.queueEngine.executeOnce();
        await expect.poll(() => readDrainsNaming(b, second)).toHaveLength(1);

        expect(readReceived(b)).toEqual(['m-2']);
        expect(log.statements.map((statement) => toNamedStatementShape(statement, namespace))).toEqual([
            // The page of new rows.
            { verb: 'select', transaction: null },
            ...toReadinessReads(second),
            // The read of rows out of attempts, the reservation, then the read of reserved rows whose lease ran out.
            { verb: 'select', transaction: 1 },
            ...toRowReservation(second, 2),
            { verb: 'select', transaction: 3 },
            // The delivery's own surface, its completion, the read of the slot after it, then the batch's release.
            toAutocommitRead(`delivered:${TRACK_KEY}`),
            ...toCompletionReads(second),
            { verb: 'with', transaction: 4 },
            toAutocommitRead(toSlotKey(3)),
            { verb: 'update', transaction: 5 }
        ]);
    });

    // Pins what a refused hand-on costs, by the batch's whole statement list: with the successor's delivery not ready,
    // the slot read, the row read and the readiness reads; with its row reserved by another instance, whose lease has not
    // run out, the slot read and the row read and nothing more. A second fact: no statement of the batch writes the row
    // by its key or its id. Where the row is reserved elsewhere that holds even past a loosened due check, since the
    // locked read takes only new or retried rows, so there the list is what can go red.
    postgresIt.each([
        {
            refusal: 'not-ready' as const,
            reads: (msg: ALMessage) => [...toSuccessorLookup(msg), ...toReadinessReads(msg)],
            stored: { status: EntityStatus.NEW, attempts: 0 }
        },
        {
            refusal: 'reserved-elsewhere' as const,
            reads: toSuccessorLookup,
            stored: { status: EntityStatus.RESERVED, attempts: 1 }
        }
    ])('costs a refused hand-on its reads of the successor and nothing more: $refusal', async ({ refusal, reads, stored }) => {
        const namespace = `${RUN_ID}-refused-${refusal}`;
        const log = createStatementLog();
        const hold = createDispatchHold(1);
        const a = createInstance({
            sql: recordPostgresStatements(instanceA!, log, null),
            namespace,
            instance: 'a',
            gateDispatch: hold.gate,
            canDispatchMessage: refusal === 'not-ready' ? (msg) => msg.id.msgId !== 'm-2' : undefined
        });
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(a.stores.admissionStore, second);
        if (refusal === 'reserved-elsewhere') {
            await reserveWorkRowElsewhere(instanceA!, a, second);
        }
        const rowId = await readWorkRowId(a, second);

        clearStatementLog(log);
        hold.release();
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);

        expect(readReceived(a)).toEqual(['m-1']);
        expect(readWritesOfRow(log, { key: toEncodedDispatchId(second), rowId }).map(toRecordedPostgresStatementShape)).toEqual([]);
        expect(log.statements.map((statement) => toNamedStatementShape(statement, namespace))).toEqual([
            ...toCompletionReads(first),
            { verb: 'with', transaction: 1 },
            ...reads(second),
            // The batch's release of its one claim.
            { verb: 'update', transaction: 2 }
        ]);
        expect(readDrainsNaming(a, first)[0]).toMatchObject({ claimedEffectIds: [toDispatchId(first)], promoted: 0 });
        expect(await readWorkRow(a, second)).toEqual(stored);
    });
});

interface DispatchHold {
    readonly gate: (msg: ALMessage) => Promise<void>;
    /** Settles when the held message's dispatch has started. */
    readonly entered: Promise<void>;
    readonly release: () => void;
}

/** Holds the first dispatch of the message at `seq`, and so its claim's completion, until released. */
function createDispatchHold(seq: number): DispatchHold {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let held = false;
    onTestFinished(() => released.resolve());
    return {
        gate: async (msg) => {
            if (!held && msg.ordering?.seq === seq) {
                held = true;
                entered.resolve();
                await released.promise;
            }
        },
        entered: entered.promise,
        release: () => released.resolve()
    };
}

interface ArmedReservationHold {
    readonly hold: WorkerHold;
    readonly at: ReservationHoldPoint;
}

interface ReservationHold {
    /** Holds the next transaction that reserves observed work rows, at `at`, once. */
    arm(at: ReservationHoldPoint): WorkerHold;
    /** The armed hold, which the first matching statement takes. */
    take(): ArmedReservationHold | undefined;
}

function createReservationHold(): ReservationHold {
    let armed: ArmedReservationHold | undefined;
    return {
        arm: (at) => {
            const hold = createWorkerHold();
            onTestFinished(() => hold.release());
            armed = { hold, at };
            return hold;
        },
        take: () => {
            const taken = armed;
            armed = undefined;
            return taken;
        }
    };
}

/**
 * Holds, once armed, the transaction whose locked read reserves observed work rows: before or after that read runs.
 * Forwards neither a client's `savepoint` nor `getExecutorCounters`: no inbound admission or work path uses them.
 */
function holdPostgresReservation(source: PSqlSql, reservation: ReservationHold): PSqlSql {
    return Object.assign(createPostgresSqlCall(source, source), {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> =>
            await source.begin(async (transaction) => await write(holdLockedReservationRead(transaction, reservation)))
    });
}

function holdLockedReservationRead(transaction: PSqlSql, reservation: ReservationHold): PSqlSql {
    const query = async <Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result> => {
        const armed = strings.join('?').includes(LOCKED_RESERVATION_READ) ? reservation.take() : undefined;
        if (armed?.at === 'before-locked-read') {
            await armed.hold.arrive();
        }
        const rows = await transaction<Result>(strings, ...values);
        if (armed?.at === 'after-locked-read') {
            await armed.hold.arrive();
        }
        return rows;
    };
    return Object.assign(createPostgresSqlCall(transaction, query), {
        begin: async <T>(write: (nested: PSqlSql) => Promise<T>): Promise<T> => await transaction.begin(write)
    });
}

interface InstanceInput {
    readonly sql: PSqlSql;
    readonly namespace: string;
    /** Names the instance's worker. */
    readonly instance: string;
    /** Absent, every dispatch runs at once. */
    readonly gateDispatch?: (msg: ALMessage) => Promise<void>;
    /** Absent, every delivery reads ready. */
    readonly canDispatchMessage?: (msg: ALMessage) => boolean;
}

function createInstance(input: InstanceInput): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'ws',
        stores: createPostgresInboundRuntimeStores(input.sql, input.namespace),
        effectWorkerId: `al-inbound:${input.namespace}:${input.instance}`,
        gateDispatch: input.gateDispatch,
        canDispatchMessage: input.canDispatchMessage
    });
}

/** Reserves the message's work row through another instance's stores, as that instance's rotation would. */
async function reserveWorkRowElsewhere(sql: PSqlSql, fixture: InboundTestRuntime, msg: ALMessage): Promise<void> {
    const row = await readWorkEntry(fixture, msg);
    const elsewhere = createPostgresInboundRuntimeStores(sql, fixture.stores.admissionStore.namespace);
    const reserved = await elsewhere.workQueue.reserveEntries({
        typeIds: new Set([row.typeId]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: 1,
        observedEntries: [row]
    });
    expect(reserved.size).toBe(1);
}

async function admit(fixture: InboundTestRuntime, msg: ALMessage): Promise<void> {
    expect((await fixture.runtime.admitIncomingMessage(msg, INBOUND_TEST_SOURCE)).right?.kind).toBe('admitted');
}

function toMessage(seq: number): ALMessage {
    return createInboundTestMessage({ msgId: `m-${seq}`, seq });
}

function toDispatchId(msg: ALMessage): string {
    return toALInboundLocalDeliveryEffectId(msg, false);
}

/** The dispatch id as a work row's key carries it. */
function toEncodedDispatchId(msg: ALMessage): string {
    return encodeURIComponent(toDispatchId(msg));
}

function readReceived(fixture: InboundTestRuntime): readonly string[] {
    return fixture.deliveredMessages.map((msg) => msg.id.msgId);
}

function readDrainsNaming(fixture: InboundTestRuntime, msg: ALMessage): readonly EffectDrain[] {
    return fixture.diagnostics.filter((event): event is EffectDrain => event.kind === 'effect-drain' && event.claimedEffectIds.includes(toDispatchId(msg)));
}

async function readWorkRow(fixture: InboundTestRuntime, msg: ALMessage) {
    const row = await readWorkEntry(fixture, msg);
    return { status: row.status, attempts: row.dequeueAudit.attempts };
}

async function readWorkRowId(fixture: InboundTestRuntime, msg: ALMessage): Promise<string> {
    const id = (await readWorkEntry(fixture, msg)).db?.id;
    if (id === undefined) {
        throw new Error('A stored work row carries its row id');
    }
    return String(id);
}

async function readWorkEntry(fixture: InboundTestRuntime, msg: ALMessage) {
    const { workQueue, admissionStore } = fixture.stores;
    const row = await workQueue.getItem(toALInboundWorkKey(admissionStore.namespace, toDispatchId(msg)));
    if (row === undefined || row === null) {
        throw new Error(`No work row for ${msg.id.msgId}`);
    }
    return row;
}

function createStatementLog(): PostgresStatementLog {
    return { statements: [], transactions: 0 };
}

/** Starts the log afresh, numbering the transactions after it from one; no transaction is open when it is called. */
function clearStatementLog(log: PostgresStatementLog): void {
    log.statements.length = 0;
    log.transactions = 0;
}

/** The locked reads that tried to reserve the row `rowId` names. */
function readLockedReads(log: PostgresStatementLog, rowId: string): readonly RecordedPostgresStatement[] {
    return log.statements.filter((statement) =>
        statement.text.includes(LOCKED_RESERVATION_READ) &&
        statement.values.some((value) => Array.isArray(value) && value.map(String).includes(rowId))
    );
}

/** The statements that write the row: any but a read that names its key, or its id in an array of ids. */
function readWritesOfRow(
    log: PostgresStatementLog,
    row: { readonly key: string; readonly rowId: string; }
): readonly RecordedPostgresStatement[] {
    return log.statements.filter((statement) =>
        !statement.text.startsWith('select') &&
        !statement.text.includes(LOCKED_RESERVATION_READ) &&
        statement.values.some((value) =>
            value === row.key ||
            (Array.isArray(value) && (value.map(String).includes(row.rowId) || JSON.stringify(value).includes(row.key)))
        )
    );
}

/**
 * Settles once a drain of `fixture` names `msg`; after 3 s it fails naming what was not reached. A race that settled on
 * the hold first has already taken its answer, so this wait's later outcome is the race's to ignore.
 */
async function waitForDrainNaming(fixture: InboundTestRuntime, msg: ALMessage): Promise<void> {
    await vi.waitFor(() =>
        expect(
            readDrainsNaming(fixture, msg),
            `neither the hand-on's reservation nor a drain naming ${msg.id.msgId} was reached`
        ).toHaveLength(1), { timeout: 3_000 });
}

interface NamedStatementShape extends RecordedPostgresStatementShape {
    /** The store key the statement names, without its namespace, or the work row key; absent when it names neither. */
    readonly name?: string;
}

function toNamedStatementShape(statement: RecordedPostgresStatement, namespace: string): NamedStatementShape {
    const name = statement.values.find((value): value is string =>
        typeof value === 'string' && (value.startsWith(`${namespace}:`) || value.startsWith(encodeURIComponent('dispatch:')))
    );
    return { ...toRecordedPostgresStatementShape(statement), name: name?.replace(`${namespace}:`, '') };
}

function toAutocommitRead(name: string): NamedStatementShape {
    return { verb: 'select', transaction: null, name };
}

function toSlotKey(seq: number): string {
    return `buffered:${TRACK_KEY}:${seq}`;
}

/** A delivery's readiness reads: the message, its owner row and the track's progress. */
function toReadinessReads(msg: ALMessage): readonly NamedStatementShape[] {
    const { msgId, senderId } = msg.id;
    return [`message:${senderId}:${msgId}`, `msg-owner:${msgId}:${senderId}`, `delivered:${TRACK_KEY}`].map(toAutocommitRead);
}

/**
 * A completion's reads before its guarded write: its slot, the message and its owner row, the progress, the three
 * control rows, then the slot, the message and the progress again.
 */
function toCompletionReads(msg: ALMessage): readonly NamedStatementShape[] {
    const { msgId, senderId } = msg.id;
    const slot = toSlotKey(msg.ordering!.seq!);
    return [
        slot,
        `message:${senderId}:${msgId}`,
        `msg-owner:${msgId}:${senderId}`,
        `delivered:${TRACK_KEY}`,
        `control:pending:${msgId}:${senderId}`,
        `control:acks:${msgId}:${senderId}`,
        `control:owners:${msgId}`,
        slot,
        `message:${senderId}:${msgId}`,
        `delivered:${TRACK_KEY}`
    ].map(toAutocommitRead);
}

/** The reservation of the message's row in its own transaction: the locked read, then the update that names the row. */
function toRowReservation(msg: ALMessage, transaction: number): readonly NamedStatementShape[] {
    return [{ verb: 'with', transaction }, { verb: 'update', transaction, name: toEncodedDispatchId(msg) }];
}

/** A hand-on's lookup of the successor: the slot read, then the read of the row it names. */
function toSuccessorLookup(msg: ALMessage): readonly NamedStatementShape[] {
    return [toAutocommitRead(toSlotKey(msg.ordering!.seq!)), toAutocommitRead(toEncodedDispatchId(msg))];
}

/** A hand-on's claim: the lookup, the readiness reads and the reservation (in transaction 2). */
function toHandOnClaim(msg: ALMessage): readonly NamedStatementShape[] {
    return [...toSuccessorLookup(msg), ...toReadinessReads(msg), ...toRowReservation(msg, 2)];
}

/**
 * A round's readiness probe that finds `msg` behind its undelivered predecessor, all reads: the page of new rows, the
 * message's readiness, the predecessor's slot, message and work row, then the pages of retried and reserved rows.
 */
function toProbeBehindPredecessor(msg: ALMessage, predecessor: ALMessage): readonly NamedStatementShape[] {
    return [
        { verb: 'select', transaction: null },
        ...toReadinessReads(msg),
        toAutocommitRead(toSlotKey(predecessor.ordering!.seq!)),
        toAutocommitRead(`message:${predecessor.id.senderId}:${predecessor.id.msgId}`),
        toAutocommitRead(toEncodedDispatchId(predecessor)),
        { verb: 'select', transaction: null },
        { verb: 'select', transaction: null }
    ];
}

/** At least one row count, and every one of them zero. */
function isAllZero(rowCounts: readonly number[]): boolean {
    return rowCounts.length > 0 && rowCounts.every((rowCount) => rowCount === 0);
}
