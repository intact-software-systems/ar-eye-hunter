import { afterEach, describe, expect, it } from 'vitest';

import { PSqlAdmissionWorkBackend } from '@shared-server/al-runtime/postgres/p-sql-admission-work-backend.ts';
import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { toALReceiptRecordConfirmationPrefix } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import {
    decodeALReceiptRecordConfirmation,
    type ALReceiptRecordOpening
} from '@shared/alm/receipt-record/al-receipt-record-rows.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';

import {
    describeALReceiptRecordContract,
    type ALReceiptRecordContractInstance,
    type ALReceiptRecordContractScope
} from '../../../shared/alm/receipt-record/al-receipt-record-contract.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
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

/** Far longer than one uncontended count; a count still running after it is waiting on another's uncommitted row. */
const BLOCKED_AFTER_MS = 5_000;

interface PostgresReceiptRecordScope extends ALReceiptRecordContractScope {
    /** A fourth instance whose every commit waits for `hold` to be released. */
    readonly held: Readonly<{ record: ALReceiptRecord; hold: WorkerHold; }>;
    /** A fifth instance whose statements `log` records. */
    readonly recorded: Readonly<{ record: ALReceiptRecord; log: PostgresStatementLog; }>;
}

/** The run id every row of one scope carries and the clients that wrote them, closed after each test. */
interface OpenedPostgresScope {
    readonly runId: string;
    readonly clients: readonly PostgresSql[];
}

describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL receipt record', () => {
    const opened: OpenedPostgresScope[] = [];
    afterEach(async () => {
        await closePostgresScopes(opened.splice(0));
    });
    const createScope = () => createPostgresScope(opened);

    describeALReceiptRecordContract('PostgreSQL', createScope);

    // Each recipient owns its row, so ACKs counted on three servers at once must neither conflict nor lose one
    // another; fifty at once with pools of ten makes them truly overlap. The end that follows is the one fenced write.
    it('counts fifty confirmations of one message from three backends without one conflict', async () => {
        const scope = await createScope();
        const recipients = Array.from({ length: 50 }, (_, index) => `r${String(index + 1).padStart(2, '0')}`);
        const opening = toOpening(scope, recipients);
        expect((await scope.instances[0].record.open(opening)).right).toBeDefined();

        const results = await Promise.all(
            recipients.map((recipientPeerId, index) => scope.instances[index % 3]!.record.count({ ...opening, recipientPeerId, kind: 'confirmed' }))
        );

        expect(results.filter((result) => result.left !== undefined)).toEqual([]);
        expect(results.map((result) => result.right?.disposition)).toEqual(recipients.map(() => 'counted'));
        expect(await readStoredRecipients(scope, opening)).toEqual(recipients);
        const ended = await Promise.all(scope.instances.map((instance) => instance.record.end(opening)));
        const committed = ended.flatMap((result) => result.right === undefined ? [] : [result.right]);
        expect(committed).toHaveLength(1);
        expect(ended.filter((result) => result.left !== undefined).map((result) => result.left))
            .toEqual([{ kind: 'conflict' }, { kind: 'conflict' }]);
        expect(committed[0]?.phase).toBe('complete');
        expect(committed[0]?.confirmedRecipientPeerIds).toEqual(recipients);
    }, 60_000);

    // A count that touched a shared row (the head, a namespace lock) would wait here until the held count commits,
    // which it never does first: the second count must commit while the first is written but uncommitted.
    it('counts a second recipient while another instance\'s count is still uncommitted', async () => {
        const scope = await createScope();
        const opening = toOpening(scope, ['r1', 'r2']);
        expect((await scope.instances[0].record.open(opening)).right).toBeDefined();

        const race = await racePastHeldCommit({
            hold: scope.held.hold,
            startHeld: () => scope.held.record.count({ ...opening, recipientPeerId: 'r1', kind: 'confirmed' }),
            startRaced: () => scope.instances[1].record.count({ ...opening, recipientPeerId: 'r2', kind: 'confirmed' }),
            blockedAfterMs: BLOCKED_AFTER_MS
        });

        expect(race.raced).toBe('finished');
        expect([race.heldResult.right?.disposition, race.racedResult.right?.disposition]).toEqual(['counted', 'counted']);
        expect(await readStoredRecipients(scope, opening)).toEqual(['r1', 'r2']);
    }, 60_000);

    // Pins what one ACK costs when its head is open and it does not complete the set, the common case: the head and
    // the confirmation key in one autocommit read, the insert in one transaction, the prefix read for the tally; five
    // round trips with BEGIN and COMMIT. A change that adds a statement or a transaction to every ACK shows here.
    it('counts an ACK that finds its head and does not complete the set in a pinned number of round trips', async () => {
        const scope = await createScope();
        const opening = toOpening(scope, ['r1', 'r2', 'r3']);
        expect((await scope.instances[0].record.open(opening)).right).toBeDefined();
        const { log } = scope.recorded;
        log.statements.splice(0);
        log.transactions = 0;

        const counted = await scope.recorded.record.count({ ...opening, recipientPeerId: 'r1', kind: 'confirmed' });

        expect(counted.right?.disposition).toBe('counted');
        expect(log.transactions).toBe(1);
        expect(log.statements.map(toRecordedPostgresStatementShape)).toEqual([
            { verb: 'select', transaction: null },
            { verb: 'insert', transaction: 1 },
            { verb: 'select', transaction: null }
        ]);
    }, 60_000);
});

/**
 * Three instances over three clients of one store, each on its own clock, under a namespace of its own run id; the
 * held and recorded instances wrap the first and third clients.
 */
async function createPostgresScope(opened: OpenedPostgresScope[]): Promise<PostgresReceiptRecordScope> {
    const runId = crypto.randomUUID();
    const namespace = `receipt-record:${runId}`;
    const clients: PostgresSql[] = [];
    opened.push({ runId, clients });
    for (let index = 0; index < 3; index += 1) {
        clients.push(await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl(), 10));
    }
    const toInstance = (sql: PSqlSql): ALReceiptRecordContractInstance => {
        const clock = { nowMs: Date.now() };
        const backend = new PSqlAdmissionWorkBackend({ sql, namespace, nowMs: () => clock.nowMs });
        return { record: new ALReceiptRecord({ backend, namespace, nowMs: () => clock.nowMs }), backend, clock };
    };
    const hold = createWorkerHold();
    const log: PostgresStatementLog = { statements: [], transactions: 0 };
    return {
        namespace,
        instances: [toInstance(clients[0]!), toInstance(clients[1]!), toInstance(clients[2]!)],
        held: { record: toInstance(holdPostgresCommit(clients[0]!, hold)).record, hold },
        recorded: { record: toInstance(recordPostgresStatements(clients[2]!, log, null)).record, log }
    };
}

/** Deletes every run's rows before asserting any, so one run's leftover rows cannot keep a later run's rows. */
async function closePostgresScopes(scopes: readonly OpenedPostgresScope[]): Promise<void> {
    try {
        const written = scopes.flatMap(({ runId, clients }) => clients[0] === undefined ? [] : [{ runId, client: clients[0] }]);
        for (const { runId, client } of written) {
            await deletePostgresRunRows(client, runId);
        }
        const counts = await Promise.all(
            written.map(async ({ runId, client }) => await readPostgresRunRowCounts(client, runId))
        );
        expect(counts).toEqual(written.map(() => NO_POSTGRES_RUN_ROWS));
    }
    finally {
        await Promise.all(scopes.flatMap(({ clients }) => clients).map(async (client) => await client.end()));
    }
}

/** A deadline 30 s out: far inside the record window, and longer than any case here runs. */
function toOpening(scope: PostgresReceiptRecordScope, expectedRecipientPeerIds: readonly string[]): ALReceiptRecordOpening {
    return {
        originPeerId: 'origin',
        msgId: `msg-${crypto.randomUUID()}`,
        traceId: 'trace',
        expectedRecipientPeerIds,
        snapshotVersion: 1,
        deadlineAtMs: scope.instances[0].clock.nowMs + 30_000
    };
}

async function readStoredRecipients(
    scope: PostgresReceiptRecordScope,
    opening: ALReceiptRecordOpening
): Promise<readonly string[]> {
    const stored = await scope.instances[2].backend.list(
        toALReceiptRecordConfirmationPrefix(scope.namespace, opening),
        decodeALReceiptRecordConfirmation
    );
    return stored.map(({ value }) => value.recipientPeerId).sort();
}
