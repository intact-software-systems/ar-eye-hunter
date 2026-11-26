import { describe, expect, it, onTestFinished } from 'vitest';

import { computeOrderedSendReport } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/compute-ordered-send-report.ts';
import { runOrderedSendCell } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/run-ordered-send-cell.ts';
import { requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

/** Two publishers offer two sends a second for two seconds; each send has the room's other fourteen sessions to reach. */
const PUBLISHERS = 2;
const SENDS = 8;
const COPIES = 112;

/**
 * A healthy run ends as soon as the last receipt completes, a few hundred milliseconds after its window. A run that
 * loses a receipt waits the send's 30 s lifetime and the receipt's 30 s grace before it gives the send up, and the
 * budget lets that run end and say what it lost.
 */
const RUN_BUDGET_MS = 90_000;

/** The tables an instance's stores and queues write. */
const RUN_TABLES = ['resource_inbox', 'runtime_state_store'];

describe('ALM ordered-send cell on PostgreSQL', () => {
    postgresIt(
        'delivers every ordered send of two publishers once, in order, and completes its receipt across three instances',
        async () => {
            await expectEverySendDeliveredAndReceipted(0);
        },
        RUN_BUDGET_MS
    );

    // At 1 ms the shape stays far inside its 500 ms period; at 5 ms an answer already takes most of one.
    postgresIt(
        'delivers and receipts the same sends when every round trip to the database waits 1 ms first',
        async () => {
            await expectEverySendDeliveredAndReceipted(1);
        },
        RUN_BUDGET_MS
    );
});

async function expectEverySendDeliveredAndReceipted(delayMs: number): Promise<void> {
    const runId = crypto.randomUUID();

    const run = await runOrderedSendCell({
        shape: { publishers: PUBLISHERS, sendsPerSecond: 2, durationS: 2, delayMs },
        databaseUrl: await createRunSchema(runId),
        runId
    });

    expect(run.left).toBeUndefined();
    const report = computeOrderedSendReport(run.right!);
    expect(report.unmatched).toEqual({
        sendsWithARepeatedMsgId: 0,
        arrivalsOfUnknownMessage: 0,
        arrivalsAtUnexpectedRecipient: 0,
        handOffsOfUnknownMessage: 0,
        receiptsOfUnknownMessage: 0,
        receiptsOfASendNotAccepted: 0,
        controlsOfUnknownMessage: 0,
        unclassifiedControls: 0
    });
    expect(report.sends.attempted).toBe(SENDS);
    expect(report.sends.byAcceptance.admitted + report.sends.byAcceptance['pending-admission']).toBe(SENDS);
    expect(report.sends.latenessMs.unrecordedSamples).toBe(0);
    expect(report.delivery).toMatchObject({
        handedToApplication: SENDS,
        handedMoreThanOnce: 0,
        deliveredToEveryRecipient: SENDS,
        copiesExpected: COPIES,
        copiesRead: COPIES,
        copiesReadMoreThanOnce: 0,
        copiesReadOutOfTrackOrder: 0,
        copiesReadPastAnUnreadPredecessor: 0
    });
    expect(report.recipientDelays.copiesReadBeforeTheirOffer).toBe(0);
    // A receipt may be read again: an instance without the origin's socket publishes a receipt row to the cluster
    // until the row expires, so `moreThanOneTerminal` is no part of what a run must show.
    expect(report.receipts).toMatchObject({
        expected: SENDS,
        complete: SENDS,
        timedOut: 0,
        admittedWithoutTerminal: 0,
        noReceipt: 0
    });
}

/**
 * A schema of the run's own with empty copies of the tables its instances write, dropped when the test ends, and the
 * database URL that names it. An instance's outbox worker takes every WS outbox row it can see, whatever store
 * namespace wrote it, so a run shares its tables with no other test's rows.
 */
async function createRunSchema(runId: string): Promise<string> {
    const databaseUrl = new URL(requirePostgresDatabaseUrl());
    const postgres = await import('postgres');
    const sql = postgres.default(databaseUrl.toString(), { max: 1, idle_timeout: 1, onnotice: () => undefined });
    const schema = `alm_cell_${runId.replaceAll('-', '_')}`;
    onTestFinished(async () => {
        try {
            await sql`drop schema if exists ${sql(schema)} cascade`;
        }
        finally {
            await sql.end();
        }
    });
    const [{ sourceSchema }] = await sql<{ sourceSchema: string; }[]>`select current_schema() as "sourceSchema"`;
    await sql`create schema ${sql(schema)}`;
    for (const table of RUN_TABLES) {
        await sql`
            create table ${sql(schema)}.${sql(table)} (like ${sql(sourceSchema)}.${sql(table)} including all)
        `;
    }
    databaseUrl.searchParams.set('schema', schema);
    return databaseUrl.toString();
}
