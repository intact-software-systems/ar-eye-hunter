import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { OrderedSendCellObservations } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';
import { computeOrderedSendReport } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/report/compute-ordered-send-report.ts';
import {
    createDefaultOrderedSendCellRunDependencies,
    runOrderedSendCell
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/run-ordered-send-cell.ts';
import type { OrderedSendShape } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/validate-ordered-send-shape.ts';
import { requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

/** The API's own defaults: each run here gives its instances the application pool an API instance starts with. */
const API_V1_DEFAULTS = JSON.parse(
    readFileSync(
        new URL('../../../../../apps/api-v1/resources/configuration/defaults-config.json', import.meta.url),
        'utf8'
    )
);

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

/** Two publishers offer two sends a second for two seconds; each send has the room's other fourteen sessions to reach. */
const PUBLISHERS = 2;
const SENDS = 8;
const COPIES = 112;

/**
 * How long a run observes after its last offer. A reference run observes for the send's lifetime and the receipt's
 * grace, 75 s, so that a receipt that times out is still read. These sends complete their receipts a few hundred
 * milliseconds after their offer on an idle machine; 4 s is ten times that and twice the 2 s first-hop wait, so a
 * runner that is slow by an order of magnitude still reads every receipt, and a first-hop resend it provokes is
 * answered before observation ends. Three runs of a 2 s window and this tail keep the file under 20 s.
 */
const OBSERVATION_TAIL_MS = 4_000;

const RUN_BUDGET_MS = 30_000;

/** The tables an instance's stores and queues write. */
const RUN_TABLES = ['resource_inbox', 'runtime_state_store'];

/**
 * What every run here must show whatever the machine's timing: nothing asserted depends on how fast an answer came,
 * on whether the server reported a gap, or on whether a publisher offered a send again.
 */
describe('ALM ordered-send cell on PostgreSQL', () => {
    postgresIt(
        'writes every copy of two publishers\' ordered sends in order and completes each receipt across three instances',
        async () => {
            const run = await runSmallCell({ delayMs: 0, senderRecovery: 'none' });

            expectEverySendWrittenAndReceipted(run);
            expect(run.resends).toEqual([]);
            expect(run.sendEnds).toEqual([]);
        },
        RUN_BUDGET_MS
    );

    // At 1 ms the shape stays far inside its 500 ms period; at 5 ms an answer already takes most of one.
    postgresIt(
        'writes and receipts the same sends when every delayed round trip to the database waits 1 ms first',
        async () => {
            const run = await runSmallCell({ delayMs: 1, senderRecovery: 'none' });

            expectEverySendWrittenAndReceipted(run);
        },
        RUN_BUDGET_MS
    );

    // A publisher that stands in for a client may offer a send again when its receipt is slow; the server has
    // admitted the send by then, and its complete receipt ends the send at the stand-in.
    postgresIt(
        'writes and receipts the same sends when its publishers stand in for a client, and ends each on its complete receipt',
        async () => {
            const run = await runSmallCell({ delayMs: 0, senderRecovery: 'client-stand-in' });

            expectEverySendWrittenAndReceipted(run);
            expect(run.resends.filter((resend) => resend.acceptance !== 'unanswered').map((resend) => resend.acceptance))
                .toEqual(run.resends.filter((resend) => resend.acceptance !== 'unanswered').map(() => 'duplicate'));
            expect(run.sendEnds.map((end) => end.cause)).toEqual(Array.from({ length: SENDS }, () => 'terminal-receipt'));
            expect(run.declinedRepairs.filter((declined) => declined.reason !== 'send-ended')).toEqual([]);
        },
        RUN_BUDGET_MS
    );
});

async function runSmallCell(
    shape: Pick<OrderedSendShape, 'delayMs' | 'senderRecovery'>
): Promise<OrderedSendCellObservations> {
    const runId = crypto.randomUUID();

    const run = await runOrderedSendCell({
        shape: {
            publishers: PUBLISHERS,
            sendsPerSecond: 2,
            durationS: 2,
            applicationPoolMaxConnections: API_V1_DEFAULTS.database.applicationPool.maxConnections,
            ...shape
        },
        databaseUrl: await createRunSchema(runId),
        runId,
        observationTailMs: OBSERVATION_TAIL_MS
    }, createDefaultOrderedSendCellRunDependencies());

    expect(run.left).toBeUndefined();
    // The process is read from the window's opening to its last offer, which is due 1,750 ms in and never early,
    // and then over the tail.
    const { sendWindow, tail } = run.right!.runtime;
    expect(sendWindow.wallMs).toBeGreaterThanOrEqual(1_750);
    expect(sendWindow.loopLag.ticks).toBeGreaterThan(0);
    expect(sendWindow.cpu.coresBusy).toBeGreaterThan(0);
    expect(tail.loopLag.ticks).toBeGreaterThan(0);
    expect(run.right!.runtime.applicationPoolMaxConnections).toBe(API_V1_DEFAULTS.database.applicationPool.maxConnections);
    return run.right!.observations;
}

function expectEverySendWrittenAndReceipted(observations: OrderedSendCellObservations): void {
    const lastOfferAtMs = Math.max(...observations.sends.map((send) => send.sentAtMs));
    expect(observations.observationEndedAtMs).toBeGreaterThanOrEqual(lastOfferAtMs + OBSERVATION_TAIL_MS);
    expect(observations.sends.filter((send) => send.sentAtMs < send.dueAtMs)).toEqual([]);
    const report = computeOrderedSendReport(observations);
    expect(report.unmatched).toEqual({
        sendsWithARepeatedMsgId: 0,
        arrivalsOfUnknownMessage: 0,
        arrivalsAtUnexpectedRecipient: 0,
        handOffsOfUnknownMessage: 0,
        receiptsOfUnknownMessage: 0,
        receiptsOfASendNotAccepted: 0,
        controlsOfUnknownMessage: 0,
        unclassifiedControls: 0,
        resendsOfUnknownMessage: 0,
        sendEndsOfUnknownMessage: 0,
        declinedRepairsOfUnknownMessage: 0,
        acksOfUnknownMessage: 0
    });
    expect(report.sends.attempted).toBe(SENDS);
    expect(report.sends.byAcceptance.admitted + report.sends.byAcceptance['pending-admission']).toBe(SENDS);
    expect([report.sends, report.resends, report.acks].map((offers) => offers.threwByErrorName)).toEqual([{}, {}, {}]);
    // Exactly-once is no part of what a run must show. The server hands a send to its application before the
    // compare-and-set that completes the delivery, hands it off again when that write lost, and its router then
    // publishes the copies again; a client drops the repeat. So neither `handedMoreThanOnce` nor
    // `copiesReadMoreThanOnce` is asserted: each depends on which write wins. Nor is the absence of a NACK or a
    // repair request: the server reports a gap whenever a later send of a track is admitted first.
    expect(report.delivery).toMatchObject({
        copiesExpected: COPIES,
        copiesRead: COPIES,
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
    // One ACK for each copy, each answered as a control: counted where the send is held, relayed where it is not.
    expect(report.acks).toMatchObject({ offered: COPIES, byAcceptance: { control: COPIES } });
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
