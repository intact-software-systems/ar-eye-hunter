import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALInboundDeliveryCompletion } from '@shared/alm/inbound/admission/al-inbound-delivery-progress.ts';
import type { ALInboundAdmissionStore, ALInboundCommitBundle } from '@shared/alm/inbound/al-inbound-admission-store.ts';

import {
    createInboundTestMessage,
    createInboundTestOrderedDelivery,
    readInboundTestAdmission,
    type InboundTestBackendStores
} from '../../../shared/alm/inbound-runtime-test-fixture.ts';
import { tearBeforeMessageRead } from '../../../shared/alm/inbound/al-inbound-buffered-slot-expiry-contract.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import {
    admitPostgresInboundTestMessage,
    createPostgresInboundBackendStores
} from './test-support/create-postgres-inbound-admission-store.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';
import {
    recordPostgresStatements,
    toRecordedPostgresStatementShape,
    type PostgresStatementLog,
    type RecordedPostgresStatementShape
} from './test-support/record-postgres-statements.ts';

const RUN_ID = `al-inbound-swept-buffered-copy-${crypto.randomUUID()}`;
/** The instance's clock stands this far behind the database's, which the expiry sweep reads. */
const INSTANCE_CLOCK_BEHIND_MS = 10_000;
/** The short-lived copy's life on the instance's clock, so its rows expired 8 s ago on the database's. */
const SHORT_LIVED_MS = 2_000;
const TRACK_KEY = toALOrderingTrackKey(createInboundTestMessage({ msgId: 'track', seq: 1 }))!;
const AUTOCOMMIT_READ: RecordedPostgresStatementShape = { verb: 'select', transaction: null };

/** One namespace's stores over a client that records every statement they run. */
interface RecordedInboundStores {
    readonly stores: InboundTestBackendStores;
    readonly store: ALInboundAdmissionStore;
    readonly log: PostgresStatementLog;
    readonly namespace: string;
}

// The expiry sweep deletes every row expired by the database's clock in one statement. An instance whose clock is
// behind the database's still reads those rows as live, so its commit can read a buffered slot, lose the slot and its
// message row to the sweep, and then read the message row as gone.
describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL inbound commit across the expiry sweep', () => {
    let sql: PostgresSql | undefined;

    beforeAll(async () => {
        sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    });

    afterAll(async () => {
        if (sql !== undefined) {
            try {
                await deletePostgresRunRows(sql, RUN_ID);
                expect(await readPostgresRunRowCounts(sql, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await sql.end();
            }
        }
    });

    function createRecordedStores(name: string): RecordedInboundStores {
        const namespace = `${RUN_ID}-${name}`;
        const log: PostgresStatementLog = { statements: [], transactions: 0 };
        const stores = createPostgresInboundBackendStores(recordPostgresStatements(sql!, log, null), namespace);
        return { stores, store: stores.stores.admissionStore, log, namespace };
    }

    /** Message 1, short-lived and undelivered, holds the track's only slot; message 2's admission is read behind it. */
    async function readAdmissionBehindShortLivedCopy(name: string): Promise<RecordedInboundStores & { readonly bundle: ALInboundCommitBundle; }> {
        const recorded = createRecordedStores(name);
        await admitPostgresInboundTestMessage(recorded.store, createOrderedMessage(1, Date.now() + SHORT_LIVED_MS));
        return { ...recorded, bundle: await readInboundTestAdmission(recorded.store, createOrderedMessage(2)) };
    }

    /** The sweep's predicate on the case's namespace, run when the commit first reads the message row at `seq`. */
    function sweepBeforeMessageRead(recorded: RecordedInboundStores, seq: number): { readonly sweptRows: () => number; } {
        let sweptRows = 0;
        tearBeforeMessageRead(recorded.stores, seq, async () => {
            sweptRows = await new PSqlRuntimeStateRepository(sql!).deleteExpired(recorded.namespace);
        });
        return { sweptRows: () => sweptRows };
    }

    it('admits a send whose commit loses a buffered copy to the expiry sweep\'s delete while the database\'s clock is ahead of the instance\'s', async () => {
        freezeInstanceClockBehindDatabase();
        const torn = await readAdmissionBehindShortLivedCopy('admission');
        expect(torn.bundle.observations.ordering?.buffered.map((slot) => slot.seq)).toEqual([1]);
        const sweep = sweepBeforeMessageRead(torn, 1);

        expect(await torn.store.commitBundle(torn.bundle)).toBe('conflict');
        expect(sweep.sweptRows()).toBe(2);
        expect(await torn.store.commitBundle(await readInboundTestAdmission(torn.store, createOrderedMessage(2))))
            .toBe('committed');
        expect((await torn.store.readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() }))?.snapshot.msg.id.msgId)
            .toBe('message-2');
    });

    it('spends one read of the slot\'s key, and no transaction, on that commit', async () => {
        freezeInstanceClockBehindDatabase();
        const torn = await readAdmissionBehindShortLivedCopy('admission-cost-torn');
        const twin = await readAdmissionBehindShortLivedCopy('admission-cost-twin');
        sweepBeforeMessageRead(torn, 1);
        const tornAnswer = await commitRecorded(torn, async () => await torn.store.commitBundle(torn.bundle));
        const twinAnswer = await commitRecorded(twin, async () => await twin.store.commitBundle(twin.bundle));

        expect(tornAnswer).toEqual({ answer: 'conflict', transactions: 0 });
        expect(toStatementsNaming(torn, toSlotKey(torn, 1))).toEqual([AUTOCOMMIT_READ]);
        expect(twinAnswer).toEqual({ answer: 'committed', transactions: 1 });
        expect(toStatementsNaming(twin, toSlotKey(twin, 1))).toEqual([]);
    });

    it('spends one more read of the slot\'s key, and no transaction, on a delivery completion torn the same way', async () => {
        freezeInstanceClockBehindDatabase();
        const torn = await readCompletionOfShortLivedCopy('completion-cost-torn');
        const twin = await readCompletionOfShortLivedCopy('completion-cost-twin');
        sweepBeforeMessageRead(torn, 2);
        const tornAnswer = await commitRecorded(torn, async () => await torn.store.commitDeliveryCompletion(torn.completion));
        const twinAnswer = await commitRecorded(twin, async () => await twin.store.commitDeliveryCompletion(twin.completion));

        expect(tornAnswer).toEqual({ answer: 'conflict', transactions: 0 });
        expect(toStatementsNaming(torn, toSlotKey(torn, 2))).toEqual([AUTOCOMMIT_READ, AUTOCOMMIT_READ]);
        expect(twinAnswer).toEqual({ answer: 'committed', transactions: 1 });
        // Its guarded write names the key too, inside its transaction.
        expect(toStatementsNaming(twin, toSlotKey(twin, 2)).filter((statement) => statement.transaction === null))
            .toEqual([AUTOCOMMIT_READ]);
    });

    /** Message 1 delivered; message 2, short-lived, holds the slot whose completion is read. */
    async function readCompletionOfShortLivedCopy(
        name: string
    ): Promise<RecordedInboundStores & { readonly completion: ALInboundDeliveryCompletion; }> {
        const recorded = createRecordedStores(name);
        const first = createOrderedMessage(1);
        await admitPostgresInboundTestMessage(recorded.store, first);
        expect(await createInboundTestOrderedDelivery(recorded.store).complete(first)).toMatchObject({ kind: 'completed' });
        await admitPostgresInboundTestMessage(recorded.store, createOrderedMessage(2, Date.now() + SHORT_LIVED_MS));
        const read = (await recorded.store.readBufferedRelease({ trackKey: TRACK_KEY, seq: 2, nowMs: Date.now() }))!;
        const completion: ALInboundDeliveryCompletion = {
            trackKey: TRACK_KEY,
            seq: 2,
            observedSlot: read.snapshot,
            observedProgress: read.observations.deliveryProgress!.value!
        };
        return { ...recorded, completion };
    }
});

/** Frozen, so the commit reaches the copy while it is still live on this clock however slowly the case runs. */
function freezeInstanceClockBehindDatabase(): void {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - INSTANCE_CLOCK_BEHIND_MS);
    onTestFinished(() => now.mockRestore());
}

function createOrderedMessage(seq: number, expiresAtMs?: number): ALMessage {
    const message = createInboundTestMessage({ msgId: `message-${seq}`, seq });
    return expiresAtMs === undefined ? message : { ...message, constraints: { expiresAtMs } };
}

/** The commit's answer and the transactions it opened, its statements alone in the log. */
async function commitRecorded(
    recorded: RecordedInboundStores,
    commit: () => Promise<'committed' | 'conflict' | 'expired'>
): Promise<{ readonly answer: string; readonly transactions: number; }> {
    recorded.log.statements.length = 0;
    const transactionsBefore = recorded.log.transactions;
    const answer = await commit();
    return { answer, transactions: recorded.log.transactions - transactionsBefore };
}

function toStatementsNaming(recorded: RecordedInboundStores, key: string): readonly RecordedPostgresStatementShape[] {
    return recorded.log.statements.filter((statement) => JSON.stringify(statement.values).includes(JSON.stringify(key)))
        .map(toRecordedPostgresStatementShape);
}

function toSlotKey(recorded: RecordedInboundStores, seq: number): string {
    return `${recorded.namespace}:buffered:${TRACK_KEY}:${seq}`;
}
