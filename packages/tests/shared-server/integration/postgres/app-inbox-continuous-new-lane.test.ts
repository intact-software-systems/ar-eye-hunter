import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import type { DequeueController } from '@shared/queuebox/dequeue/dequeue-controller.ts';
import { ResourceInboxResilience } from '@shared/queuebox/resource-inbox/resource-inbox-resilience.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { DEFAULT_RESOURCE_INBOX_RETRY_POLICY } from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import { CircuitBreakerPolicy } from '@shared/resilience/circuit-breaker.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const TYPE = 'app-inbox.continuous-new-lane.v1';
const K = 4;
const H = 16;
const CONTEXTS = 50;
const ROWS_PER_CONTEXT = 3;
const KEYED_ROWS = 20;
const GROUP_KEY = 'app:group-shared';
const KEYLESS_HANDLER_MS = 10;
const KEYED_HANDLER_MS = 15;
const TOTAL_ROWS = CONTEXTS * ROWS_PER_CONTEXT + KEYED_ROWS;

interface HandlerSpan {
    readonly rowId: string;
    readonly readerId: string;
    readonly keyed: boolean;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
}

interface LaneRun {
    readonly wallMs: number;
    readonly passes: number;
    readonly spans: readonly HandlerSpan[];
    /** Contexts seen with two RESERVED rows at once while the run went on. */
    readonly doubleReservedContexts: readonly string[];
    readonly rows: readonly { status: string; attempts: number; }[];
}

interface LaneReader {
    readonly readerId: string;
    readonly reader: InboxQueueReader;
    readonly settlements: Promise<void>[];
    /** Resolves at the first row settlement after the call. */
    readNextSettlement(): Promise<void>;
}

describe('the AppInbox NEW lane on PostgreSQL', () => {
    postgresIt('runs a standing flight that keeps contexts and exclusion keys apart, completes every row once and beats the draining pass', async () => {
        const draining = await runSeededLane({ readerCount: 1, newLaneHeldRows: undefined });
        const flight = await runSeededLane({ readerCount: 1, newLaneHeldRows: H });

        for (const run of [draining, flight]) {
            expect(run.doubleReservedContexts).toEqual([]);
            expect(findOverlappingContextSpans(run.spans)).toEqual([]);
            expect(findOverlappingKeyedSpans(run.spans)).toEqual([]);
            expect(run.spans).toHaveLength(TOTAL_ROWS);
            expect(run.rows).toEqual(Array(TOTAL_ROWS).fill({ status: EntityStatus.COMPLETED, attempts: 1 }));
        }
        console.info('AppInbox NEW lane wall on PostgreSQL', {
            drainingPassWallMs: draining.wallMs,
            drainingPasses: draining.passes,
            standingFlightWallMs: flight.wallMs,
            standingFlightPasses: flight.passes
        });
    }, 120_000);

    postgresIt('keeps each reader\'s contexts and exclusion keys apart when two readers share one store', async () => {
        const run = await runSeededLane({ readerCount: 2, newLaneHeldRows: H });

        for (const readerId of ['reader-0', 'reader-1']) {
            expect(findOverlappingKeyedSpans(run.spans.filter((span) => span.readerId === readerId))).toEqual([]);
            expect(findOverlappingContextSpans(run.spans.filter((span) => span.readerId === readerId))).toEqual([]);
        }
        expect(run.spans).toHaveLength(TOTAL_ROWS);
        expect(new Set(run.spans.map((span) => span.readerId)).size).toBe(2);
        expect(run.rows).toEqual(Array(TOTAL_ROWS).fill({ status: EntityStatus.COMPLETED, attempts: 1 }));
        console.info('AppInbox NEW lane with two readers on PostgreSQL', {
            wallMs: run.wallMs,
            passes: run.passes,
            doubleReservedContextsAcrossReaders: run.doubleReservedContexts.length
        });
    }, 120_000);
});

describe('the AppInbox standing flight\'s recovery lanes on PostgreSQL', () => {
    postgresIt('claims no overdue retry of a context it holds a row of in flight, and claims another context\'s instead', async () => {
        const lane = await createRecoveryLane('app_inbox_flight_fairness');
        await enqueue(lane.reader, 'context-a', 'held');
        expect(await lane.pass(undefined)).toBe(1);

        await enqueue(lane.reader, 'context-a', 'overdue-a');
        await enqueue(lane.reader, 'context-b', 'overdue-b');
        await writeOverdueRetry(lane.sql, 'overdue-a', 120);
        await writeOverdueRetry(lane.sql, 'overdue-b', 60);
        expect(await lane.pass(undefined)).toBe(1);

        // FAIRNESS claims the most overdue row it may: context-a's would be a second RESERVED row beside `held`.
        expect(await readReservedResourceIds(lane.sql)).toEqual(['held', 'overdue-b']);
        await lane.finishAll(['held', 'overdue-b']);
    }, 30_000);

    postgresIt('reclaims no timed-out reservation of a context it holds a row of in flight, and reclaims another context\'s instead', async () => {
        const lane = await createRecoveryLane('app_inbox_flight_timeout');
        await enqueue(lane.reader, 'context-a', 'peer-held');
        await enqueue(lane.reader, 'context-a', 'held');
        await enqueue(lane.reader, 'context-b', 'peer-held-b');
        // A peer reserved each context's first row and then died; context-a's next NEW row is now its head.
        await writeReservation(lane.sql, 'peer-held', 0);
        await writeReservation(lane.sql, 'peer-held-b', 0);
        expect(await lane.pass(ONLY_NEW)).toBe(1);

        await writeReservation(lane.sql, 'peer-held', LAPSED_LEASE_SECONDS);
        await writeReservation(lane.sql, 'peer-held-b', LAPSED_LEASE_SECONDS);
        expect(await lane.pass(ONLY_TIMEOUT)).toBe(1);

        // Reclaiming `peer-held` would run a second row of context-a beside `held` on this instance.
        await lane.finishAll(['held', 'peer-held-b']);
    }, 30_000);
});

/** Past the default reservation lease of five minutes, so the TIMEOUT lane may reclaim the row. */
const LAPSED_LEASE_SECONDS = 400;
const ONLY_NEW: DequeueController.WorkAdvertisement = { FINALIZATION: false, NEW: true, RETRY: false, FAIRNESS: false, TIMEOUT: false };
const ONLY_TIMEOUT: DequeueController.WorkAdvertisement = { ...ONLY_NEW, NEW: false, TIMEOUT: true };

interface RecoveryLane {
    readonly sql: PSqlSql;
    readonly reader: InboxQueueReader;
    pass(workAdvertisement: DequeueController.WorkAdvertisement | undefined): Promise<number>;
    /** Waits until exactly these rows' handlers started, then lets each finish and joins the flight. */
    finishAll(rowIds: readonly string[]): Promise<void>;
}

async function createRecoveryLane(schemaPrefix: string): Promise<RecoveryLane> {
    const storage = await createResourceInboxTestStorage(schemaPrefix, 2);
    onTestFinished(() => storage.close());
    const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
    const gates = new Map<string, () => void>();
    const settlements: Promise<void>[] = [];
    const reader = new InboxQueueReader(queue, {
        newLaneConcurrency: K,
        newLaneHeldRows: H,
        flightEntryListener: (settlement) => settlements.push(settlement)
    });
    reader.onInboxMessageDo(TYPE, {
        onMessage: async (_message, entry) => {
            await new Promise<void>((resolve) => gates.set(entry.key.resourceId, resolve));
        }
    });
    const resilience = createResilience();
    return {
        sql: storage.sql,
        reader,
        pass: (workAdvertisement) => reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience, workAdvertisement),
        finishAll: async (rowIds) => {
            await vi.waitFor(() => expect([...gates.keys()].sort()).toEqual([...rowIds].sort()));
            for (const release of gates.values()) {
                release();
            }
            await Promise.all(settlements);
        }
    };
}

/** Marks a row RESERVED by an attempt that started the given seconds ago. */
async function writeReservation(sql: PSqlSql, resourceId: string, startedSecondsAgo: number): Promise<void> {
    await sql`
        update resource_inbox
        set ri_status = ${EntityStatus.RESERVED},
            ri_attempts = 1,
            start_ts = (now() at time zone 'UTC') - (${startedSecondsAgo} * interval '1 second'),
            end_ts = null,
            next_ts = null
        where ri_resource_id = ${resourceId}`;
}

/** Turns a NEW row into a RETRY row whose next attempt fell due the given seconds ago. */
async function writeOverdueRetry(sql: PSqlSql, resourceId: string, overdueSeconds: number): Promise<void> {
    await sql`
        update resource_inbox
        set ri_status = ${EntityStatus.RETRY},
            ri_attempts = 1,
            start_ts = (now() at time zone 'UTC') - ((${overdueSeconds} + 2) * interval '1 second'),
            end_ts = (now() at time zone 'UTC') - ((${overdueSeconds} + 1) * interval '1 second'),
            next_ts = (now() at time zone 'UTC') - (${overdueSeconds} * interval '1 second')
        where ri_resource_id = ${resourceId}`;
}

async function readReservedResourceIds(sql: PSqlSql): Promise<string[]> {
    const rows = await sql<{ ri_resource_id: string; }[]>`
        select ri_resource_id from resource_inbox where ri_status = ${EntityStatus.RESERVED} order by ri_resource_id`;
    return rows.map((row) => row.ri_resource_id);
}

async function runSeededLane(input: Readonly<{ readerCount: number; newLaneHeldRows: number | undefined; }>): Promise<LaneRun> {
    const storage = await createResourceInboxTestStorage('app_inbox_continuous_lane', 6);
    onTestFinished(() => storage.close());
    const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(storage.sql, () => new Date()), Temporal.Now.instant);
    const spans: HandlerSpan[] = [];
    const readers = Array.from(
        { length: input.readerCount },
        (_value, index) => createLaneReader({ queue, readerId: `reader-${index}`, newLaneHeldRows: input.newLaneHeldRows, spans })
    );
    await seedRows(readers[0]!.reader);

    const watch = watchDoubleReservedContexts(storage.sql);
    const startedAtMs = performance.now();
    const passes = await Promise.all(readers.map((reader) => driveReader(reader, spans)));
    const wallMs = performance.now() - startedAtMs;
    const doubleReservedContexts = await watch.stop();
    const rows = await storage.sql<{ ri_status: string; ri_attempts: number; }[]>`
        select ri_status, ri_attempts from resource_inbox where ri_type_id = ${InboxQueueReader.INBOX_ENQUEUE_TYPE}`;
    return {
        wallMs: Math.round(wallMs),
        passes: passes.reduce((total, count) => total + count, 0),
        spans,
        doubleReservedContexts,
        rows: rows.map((row) => ({ status: row.ri_status, attempts: Number(row.ri_attempts) }))
    };
}

function createLaneReader(
    input: Readonly<{ queue: PSqlQueueBox; readerId: string; newLaneHeldRows: number | undefined; spans: HandlerSpan[]; }>
): LaneReader {
    const settlements: Promise<void>[] = [];
    let nextSettlement = Promise.withResolvers<void>();
    const announceSettlement = () => {
        const settled = nextSettlement;
        nextSettlement = Promise.withResolvers<void>();
        settled.resolve();
    };
    const reader = new InboxQueueReader(input.queue, {
        newLaneConcurrency: K,
        newLaneHeldRows: input.newLaneHeldRows,
        flightEntryListener: (settlement) => {
            settlements.push(settlement);
            void settlement.then(announceSettlement);
        },
        toComputeExclusionKey: (key) => key.resourceId.startsWith('keyed-') ? GROUP_KEY : undefined
    });
    reader.onInboxMessageDo(TYPE, {
        onMessage: async (_message, entry) => {
            const keyed = entry.key.resourceId.startsWith('keyed-');
            const startedAtMs = performance.now();
            await new Promise((resolve) => setTimeout(resolve, keyed ? KEYED_HANDLER_MS : KEYLESS_HANDLER_MS));
            input.spans.push({
                rowId: `${entry.key.contextId}/${entry.key.resourceId}`,
                readerId: input.readerId,
                keyed,
                startedAtMs,
                finishedAtMs: performance.now()
            });
        }
    });
    return { readerId: input.readerId, reader, settlements, readNextSettlement: () => nextSettlement.promise };
}

/**
 * Passes back to back like the engine: a draining pass resolves once its rows are released, and a standing flight's
 * pass is followed by the next as soon as a row settles whenever it would otherwise claim nothing.
 */
async function driveReader(lane: LaneReader, spans: readonly HandlerSpan[]): Promise<number> {
    const resilience = createResilience();
    let passes = 0;
    while (spans.length < TOTAL_ROWS) {
        passes += 1;
        const nextSettlement = lane.readNextSettlement();
        const claimed = await lane.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, resilience);
        if (lane.reader.isAwaitingFlightSettlement()) {
            await nextSettlement;
        }
        else if (claimed === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }
    await Promise.all(lane.settlements);
    return passes;
}

/** A context's rows are queued back to back, so its next row is the oldest claimable row once its head is reserved. */
async function seedRows(reader: InboxQueueReader): Promise<void> {
    for (let context = 0; context < CONTEXTS; context += 1) {
        if (context < KEYED_ROWS) {
            await enqueue(reader, `joiner-${context}`, `keyed-${context}`);
        }
        for (let round = 0; round < ROWS_PER_CONTEXT; round += 1) {
            await enqueue(reader, `context-${context}`, `row-${round}`);
        }
    }
}

async function enqueue(reader: InboxQueueReader, contextId: string, resourceId: string): Promise<void> {
    await reader.enqueueIfAbsent(newALUntargetedMessage(
        'api-v1',
        newALRoute('app-inbox.continuous-new-lane', contextId, resourceId),
        TYPE,
        { resourceId },
        { ttlMs: 300_000 }
    ));
}

/** Polls the store while the run goes on for any context holding two RESERVED rows at once. */
function watchDoubleReservedContexts(sql: PSqlSql): { stop(): Promise<string[]>; } {
    const seen = new Set<string>();
    let watching = true;
    const polling = (async () => {
        while (watching) {
            const rows = await sql<{ fk_ext_bank_id: string; }[]>`
                select fk_ext_bank_id from resource_inbox
                where ri_status = ${EntityStatus.RESERVED} and ri_type_id = ${InboxQueueReader.INBOX_ENQUEUE_TYPE}
                group by fk_ext_bank_id having count(*) > 1`;
            rows.forEach((row) => seen.add(row.fk_ext_bank_id));
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    })();
    return {
        stop: async () => {
            watching = false;
            await polling;
            return [...seen].sort();
        }
    };
}

function findOverlappingKeyedSpans(spans: readonly HandlerSpan[]): string[] {
    const keyed = spans.filter((span) => span.keyed).sort((left, right) => left.startedAtMs - right.startedAtMs);
    return keyed.slice(1).flatMap((span, index) => span.startedAtMs < keyed[index]!.finishedAtMs ? [`${keyed[index]!.rowId} overlaps ${span.rowId}`] : []);
}

function findOverlappingContextSpans(spans: readonly HandlerSpan[]): string[] {
    const byContext = Map.groupBy(spans, (span) => span.rowId.split('/')[0]!);
    return [...byContext.values()].flatMap((contextSpans) => findOverlappingKeyedSpans(contextSpans.map((span) => ({ ...span, keyed: true }))));
}

function createResilience(): ResourceInboxResilience {
    const duration = Temporal.Duration.from({ seconds: 10 });
    return ResourceInboxResilience.createDefault({
        circuitBreakerPolicy: new CircuitBreakerPolicy(10, duration, duration, duration),
        initialRate: 1,
        maxRate: 10,
        concurrencyIncreaseStep: 1,
        concurrencyReduceStep: 1,
        retryPolicy: DEFAULT_RESOURCE_INBOX_RETRY_POLICY
    });
}
