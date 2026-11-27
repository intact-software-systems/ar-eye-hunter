import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished
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

    // Pins the hand-on across instances: the successor B's admission wrote, which B's own round set aside behind its
    // predecessor, waited for the rotation after A completed that predecessor; A's batch now delivers it, once, in order.
    postgresIt('delivers in the completing instance\'s batch a successor another instance admitted', async () => {
        const namespace = `${RUN_ID}-across`;
        const hold = createDispatchHold(1);
        const a = createInstance(instanceA!, namespace, 'a', hold.gate);
        const b = createInstance(instanceB!, namespace, 'b', undefined);
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(b.stores.admissionStore, second);
        expect(await b.queueEngine.executeOnce()).toBe(false);
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
    // reservation returns no row and writes nothing for it.
    postgresIt.each([
        { at: 'before-locked-read' as const, winner: 'b' as const },
        { at: 'after-locked-read' as const, winner: 'a' as const }
    ])('delivers the successor once when both instances reach for it, held $at', async ({ at, winner }) => {
        const namespace = `${RUN_ID}-race-${at}`;
        const [logA, logB] = [createStatementLog(), createStatementLog()];
        const hold = createDispatchHold(1);
        const reservation = createReservationHold();
        const a = createInstance(
            holdPostgresReservation(recordPostgresStatements(instanceA!, logA, null), reservation),
            namespace,
            'a',
            hold.gate
        );
        const b = createInstance(recordPostgresStatements(instanceB!, logB, null), namespace, 'b', undefined);
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(b.stores.admissionStore, second);
        expect(await b.queueEngine.executeOnce()).toBe(false);
        expect(await readWorkRow(b, second)).toEqual({ status: EntityStatus.NEW, attempts: 0 });
        const rowId = await readWorkRowId(b, second);

        const held = reservation.arm(at);
        hold.release();
        await held.arrived;
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
        expect(readStatementsNaming(losingLog, toEncodedDispatchId(second)).map(toRecordedPostgresStatementShape)).toEqual([]);
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
        const a = createInstance(recordPostgresStatements(instanceA!, log, null), namespace, 'a', hold.gate);
        const first = toMessage(1);
        await admit(a, first);
        await hold.entered;

        clearStatementLog(log);
        hold.release();
        await expect.poll(() => readDrainsNaming(a, first)).toHaveLength(1);

        const nextSlot = readStatementsNaming(log, `${namespace}:buffered:${TRACK_KEY}:2`);
        expect(nextSlot.map(toRecordedPostgresStatementShape)).toEqual([{ verb: 'select', transaction: null }]);
        expect(log.statements.filter((statement) => statement.text.includes('resource_inbox')).map(toRecordedPostgresStatementShape))
            .toEqual([{ verb: 'update', transaction: 2 }]);
        // The completion's reads (10), its guarded write, the read of the slot after it, the batch's release.
        expect(log.statements.map(toRecordedPostgresStatementShape)).toEqual([
            ...toAutocommitReads(10),
            { verb: 'with', transaction: 1 },
            ...toAutocommitReads(1),
            { verb: 'update', transaction: 2 }
        ]);
    });

    // Pins the price of a hand-on: beyond what the rotation spends on the same row (the readiness reads and the
    // reservation), the slot read and the row read.
    postgresIt('costs a hand-on its slot read and its row read beyond the rotation\'s readiness reads and reservation', async () => {
        const namespace = `${RUN_ID}-hand-on`;
        const log = createStatementLog();
        const hold = createDispatchHold(1);
        const a = createInstance(recordPostgresStatements(instanceA!, log, null), namespace, 'a', hold.gate);
        const [first, second] = [toMessage(1), toMessage(2)];
        await admit(a, first);
        await hold.entered;
        await admitPostgresInboundTestMessage(a.stores.admissionStore, second);

        clearStatementLog(log);
        hold.release();
        await expect.poll(() => readDrainsNaming(a, second)).toHaveLength(1);

        expect(readReceived(a)).toEqual(['m-1', 'm-2']);
        // The hand-on's slot read, then the second completion's two reads of that same slot.
        expect(readStatementsNaming(log, `${namespace}:buffered:${TRACK_KEY}:2`).map(toRecordedPostgresStatementShape))
            .toEqual(toAutocommitReads(3));
        expect(readStatementsNaming(log, toEncodedDispatchId(second)).map(toRecordedPostgresStatementShape)).toEqual([
            { verb: 'select', transaction: null },
            { verb: 'update', transaction: 2 }
        ]);
        expect(log.statements.map(toRecordedPostgresStatementShape)).toEqual([
            // The first completion: its reads (10) and its guarded write.
            ...toAutocommitReads(10),
            { verb: 'with', transaction: 1 },
            // The hand-on: the slot read, the row read, the readiness reads (the message, its owner row, the progress),
            // and the reservation (the locked read and the update).
            ...toAutocommitReads(5),
            { verb: 'with', transaction: 2 },
            { verb: 'update', transaction: 2 },
            // The second delivery: its own surface (3), its completion's reads (10) and write, the read of the slot
            // after it, then the batch's release of both rows.
            ...toAutocommitReads(13),
            { verb: 'with', transaction: 3 },
            ...toAutocommitReads(1),
            { verb: 'update', transaction: 4 }
        ]);
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

/** Holds, once armed, the transaction whose locked read reserves observed work rows: before or after that read runs. */
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

function createInstance(
    sql: PSqlSql,
    namespace: string,
    instance: string,
    gateDispatch: ((msg: ALMessage) => Promise<void>) | undefined
): InboundTestRuntime {
    return createInboundTestRuntime({
        carrier: 'ws',
        stores: createPostgresInboundRuntimeStores(sql, namespace),
        effectWorkerId: `al-inbound:${namespace}:${instance}`,
        gateDispatch
    });
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

function readStatementsNaming(log: PostgresStatementLog, name: string): readonly RecordedPostgresStatement[] {
    return log.statements.filter((statement) => statement.values.some((value) => value === name));
}

/** At least one row count, and every one of them zero. */
function isAllZero(rowCounts: readonly number[]): boolean {
    return rowCounts.length > 0 && rowCounts.every((rowCount) => rowCount === 0);
}

function toAutocommitReads(count: number): readonly RecordedPostgresStatementShape[] {
    return Array.from({ length: count }, () => ({ verb: 'select', transaction: null }));
}
