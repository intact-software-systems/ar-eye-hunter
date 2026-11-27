import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createPSqlALReceiptRecordStores } from '@shared-server/al-runtime/postgres/create-p-sql-al-receipt-record-stores.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import { ALReceiptRecord } from '@shared/alm/receipt-record/al-receipt-record.ts';

import { toOrderedSendStoreNamespace } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/instance/create-ordered-send-ws-server.ts';
import type { OrderedSendCellObservations } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/ordered-send-cell-observations.ts';
import { computeOrderedSendReport } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/report/compute-ordered-send-report.ts';
import {
    createDefaultOrderedSendCellRunDependencies,
    runOrderedSendCell
} from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/run-ordered-send-cell.ts';
import type { OrderedSendShape } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/validate-ordered-send-shape.ts';
import { toPostgresJsConnectionUrl } from '../../../../../apps/api-v1/src/db/api-v1-database-lifecycle.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

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
 * grace, 75 s, so that a receipt that times out is still read. On an idle machine the median send here completes its
 * receipt a few hundred milliseconds after its offer, and 4 s is about ten times that median. It is no such margin
 * over the slow sends: on the build before the receipt record, at the reference load, five publishers and no added
 * latency, the 99th percentile from offer to complete receipt reached about 2 s, so the tail is a small multiple of
 * a slow receipt, and twice the 2 s first-hop wait. Three runs of a 2 s window and this tail keep the file under 20 s.
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
            const { observations, record } = await runSmallCell({ delayMs: 0, senderRecovery: 'none' });

            expectEverySendWrittenAndReceipted(observations);
            await expectEveryReceiptEndedCompleteInTheSharedRecord(observations, record);
            expect(observations.resends).toEqual([]);
            expect(observations.sendEnds).toEqual([]);
        },
        RUN_BUDGET_MS
    );

    // At 1 ms the shape stays far inside its 500 ms period; at 5 ms an answer already takes most of one.
    postgresIt(
        'writes and receipts the same sends when every delayed round trip to the database waits 1 ms first',
        async () => {
            const { observations, record } = await runSmallCell({ delayMs: 1, senderRecovery: 'none' });

            expectEverySendWrittenAndReceipted(observations);
            await expectEveryReceiptEndedCompleteInTheSharedRecord(observations, record);
        },
        RUN_BUDGET_MS
    );

    // A publisher that stands in for a client may offer a send again: when its receipt is slow, by which time the
    // server has usually admitted the send and answers `duplicate`; or for a repair the server asked for while the
    // first offer was still on its way, which the entry may answer `admitted` or `pending-admission` in its place.
    // The entry refuses no such offer, and the send's complete receipt ends it at the stand-in.
    postgresIt(
        'writes and receipts the same sends when its publishers stand in for a client, and ends each on its complete receipt',
        async () => {
            const { observations, record } = await runSmallCell({ delayMs: 0, senderRecovery: 'client-stand-in' });

            expectEverySendWrittenAndReceipted(observations);
            await expectEveryReceiptEndedCompleteInTheSharedRecord(observations, record);
            expect(observations.resends.filter((resend) => ['rejected', 'threw', 'not-admitted'].includes(resend.acceptance)))
                .toEqual([]);
            expect(observations.sendEnds.map((end) => end.cause)).toEqual(Array.from({ length: SENDS }, () => 'terminal-receipt'));
            expect(observations.declinedRepairs.filter((declined) => declined.reason !== 'send-ended')).toEqual([]);
        },
        RUN_BUDGET_MS
    );
});

/** What a small run observed, and the receipt record its three instances share, read on the run's own schema. */
interface SmallCellRun {
    readonly observations: OrderedSendCellObservations;
    readonly record: ALReceiptRecord;
}

async function runSmallCell(shape: Pick<OrderedSendShape, 'delayMs' | 'senderRecovery'>): Promise<SmallCellRun> {
    const runId = crypto.randomUUID();
    const databaseUrl = await createRunSchema(runId);

    const run = await runOrderedSendCell({
        shape: {
            publishers: PUBLISHERS,
            sendsPerSecond: 2,
            durationS: 2,
            applicationPoolMaxConnections: API_V1_DEFAULTS.database.applicationPool.maxConnections,
            ...shape
        },
        databaseUrl,
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
    return { observations: run.right!.observations, record: await openRunReceiptRecord(databaseUrl, runId) };
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
    // A receipt may be read again: an instance without the origin's socket announces a receipt row to the cluster and
    // leaves it to be taken again until an instance holding that socket takes it or the row expires, so
    // `moreThanOneTerminal` is no part of what a run must show.
    expect(report.receipts).toMatchObject({
        expected: SENDS,
        complete: SENDS,
        timedOut: 0,
        admittedWithoutTerminal: 0,
        noReceipt: 0
    });
    // One ACK for each copy, each answered as a control by the instance its recipient's socket is on, whichever
    // instance admitted the send.
    expect(report.acks).toMatchObject({ offered: COPIES, byAcceptance: { control: COPIES } });
}

/**
 * Pins that the three instances count in one record on PostgreSQL: every send's head there ended `complete`, naming
 * each of its fourteen recipients confirmed, though five of them ACKed on each instance. A record an instance kept in
 * its own memory would leave no head on PostgreSQL, and one instance's count would never complete a send.
 */
async function expectEveryReceiptEndedCompleteInTheSharedRecord(
    observations: OrderedSendCellObservations,
    record: ALReceiptRecord
): Promise<void> {
    const ended = await Promise.all(observations.sends.map(async (send) => {
        const read = await record.read({ originPeerId: send.publisherPeerId, msgId: send.msgId });
        const head = read.right?.head;
        return {
            msgId: send.msgId,
            phase: head?.phase,
            confirmed: head?.phase === 'complete' ? [...head.confirmedRecipientPeerIds].sort() : undefined
        };
    }));
    expect(ended).toEqual(observations.sends.map((send) => ({
        msgId: send.msgId,
        phase: 'complete',
        confirmed: [...send.expectedRecipientPeerIds].sort()
    })));
}

/** The receipt record of the run's store namespace, read through a client of its own on the run's schema. */
async function openRunReceiptRecord(databaseUrl: string, runId: string): Promise<ALReceiptRecord> {
    const client = await createRuntimeStatePostgresSql(toPostgresJsConnectionUrl(databaseUrl));
    onTestFinished(async () => await client.end());
    const stores = createPSqlALReceiptRecordStores({
        repository: new PSqlRuntimeStateRepository(client),
        namespace: toOrderedSendStoreNamespace(runId),
        nowMs: Date.now
    });
    return new ALReceiptRecord({ ...stores, nowMs: Date.now });
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
