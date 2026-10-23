import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import {
    computeResourceInboxObservation,
    PSqlResourceInboxEntryRepository
} from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import type { ResourceInboxRelease } from '@shared/queuebox/queue-box-types.ts';
import {
    EntityStatus,
    type Key,
    type ResourceEntry
} from '@shared/queuebox/ResourceEntry.ts';

import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';

interface ResourceInboxRowRange {
    readonly from: number;
    readonly to: number;
}

interface SequentialScanCountRow {
    readonly seq_scan: string;
}

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

const BATCH = 16;
/** Warm beyond the first five executions before checking table growth. */
const WARM_EXECUTIONS = 7;
const TRAP_TYPE = 'PLAN_TRAP';
const SMALL_TABLE_ROWS = 200;
const GROWN_TABLE_ROWS = 20_000;

/**
 * Each recordset statement runs its warm executions on one connection while the table is small, then once more after
 * the table grew without an analyze: a plan cached on the small table is a hash join over a scan of the whole table.
 */
describe('Postgres resource inbox recordset statements', () => {
    postgresIt('release a batch through the primary key once the table grew past the size its first executions saw', async () => {
        await withSmallTable(async (sql) => {
            const queue = new PSqlQueueBox(createPSqlResourceInboxRepository(sql, () => new Date()), Temporal.Now.instant);
            for (let execution = 0; execution < WARM_EXECUTIONS; execution += 1) {
                await queue.releaseEntries(toCompletions(await reserveBatch(queue)));
            }
            await growTable(sql);
            const reserved = await reserveBatch(queue);

            const scans = await countSequentialScans(sql, async () => {
                expect((await queue.releaseEntries(toCompletions(reserved))).size).toBe(BATCH);
            });

            expect(scans).toBe(0);
        });
    });

    postgresIt('lock observed rows through the primary key once the table grew past the size its first executions saw', async () => {
        await withSmallTable(async (sql) => {
            const observations = (await readTrapEntries(sql)).map(computeResourceInboxObservation);
            const lockAll = async (): Promise<boolean> =>
                await sql.begin(async (transaction) => await new PSqlResourceInboxEntryRepository(transaction, () => new Date()).lockAllObserved(observations));
            for (let execution = 0; execution < WARM_EXECUTIONS; execution += 1) {
                expect(await lockAll()).toBe(true);
            }
            await growTable(sql);

            const scans = await countSequentialScans(sql, async () => {
                expect(await lockAll()).toBe(true);
            });

            expect(scans).toBe(0);
        });
    });

    postgresIt('find rows by key through the unique key once the table grew past the size its first executions saw', async () => {
        await withSmallTable(async (sql) => {
            for (let execution = 0; execution < WARM_EXECUTIONS; execution += 1) {
                expect(await readTrapEntries(sql)).toHaveLength(BATCH);
            }
            await growTable(sql);

            const scans = await countSequentialScans(sql, async () => {
                expect(await readTrapEntries(sql)).toHaveLength(BATCH);
            });

            expect(scans).toBe(0);
        });
    });
});

/** A one-connection pool, so the warm executions and the measured one share the connection's prepared statements. */
async function withSmallTable(verify: (sql: PSqlSql) => Promise<void>): Promise<void> {
    const storage = await createResourceInboxTestStorage('recordset_plans', 1);
    try {
        await storage.sql`alter table resource_inbox set (autovacuum_enabled = false)`;
        await insertRows(storage.sql, { from: 1, to: SMALL_TABLE_ROWS });
        await verify(storage.sql);
    }
    finally {
        await storage.close();
    }
}

/**
 * The first `(WARM_EXECUTIONS + 1) * BATCH` rows are new, each its own context; the rest completed.
 * Keep system_date equal to created_ts's UTC date, as the canonical inbox writer and optimistic observation require.
 */
async function insertRows(sql: PSqlSql, range: ResourceInboxRowRange): Promise<void> {
    const trapRows = (WARM_EXECUTIONS + 1) * BATCH;
    await sql`
        insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
            fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts, start_ts, end_ts)
        select 'row-' || series, 'plan-trap', '{"body":"' || repeat(md5(series::text), 8) || '"}',
            case when series <= ${trapRows} then ${TRAP_TYPE} else 'FILLER' end,
            case when series <= ${trapRows} then 'NEW' else 'COMPLETED' end,
            'context-' || series, ((now() at time zone 'UTC') + series * interval '1 microsecond')::date, 'server-1',
            (now() at time zone 'UTC') + series * interval '1 microsecond',
            (now() at time zone 'UTC') + interval '1 day', case when series <= ${trapRows} then 0 else 1 end,
            case when series > ${trapRows} then (now() at time zone 'UTC') end,
            case when series > ${trapRows} then (now() at time zone 'UTC') end
        from generate_series(${range.from}::int, ${range.to}::int) as series`;
}

async function growTable(sql: PSqlSql): Promise<void> {
    await insertRows(sql, { from: SMALL_TABLE_ROWS + 1, to: GROWN_TABLE_ROWS });
}

async function reserveBatch(queue: PSqlQueueBox): Promise<readonly ResourceEntry[]> {
    const reserved = await queue.reserveEntries({
        typeIds: new Set([TRAP_TYPE]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: BATCH
    });
    expect(reserved.size).toBe(BATCH);
    return [...reserved.values()];
}

function toCompletions(reserved: readonly ResourceEntry[]): readonly ResourceInboxRelease[] {
    return reserved.map((entry) => ({ entry, disposition: { status: EntityStatus.COMPLETED, delayMs: null } }));
}

async function readTrapEntries(sql: PSqlSql): Promise<readonly ResourceEntry[]> {
    const keys: Key[] = Array.from({ length: BATCH }, (_, index) => ({
        topicId: 'plan-trap',
        resourceId: `row-${index + 1}`,
        contextId: `context-${index + 1}`
    }));
    const found = await new PSqlResourceInboxEntryRepository(sql, () => new Date()).findByKeys(keys);
    return found.filter((entry) => entry !== undefined);
}

/** The sequential scans of `resource_inbox` that `run` made, from the statistics the connection flushed around it. */
async function countSequentialScans(sql: PSqlSql, run: () => Promise<void>): Promise<number> {
    const before = await readSequentialScans(sql);
    await run();
    return await readSequentialScans(sql) - before;
}

async function readSequentialScans(sql: PSqlSql): Promise<number> {
    await sql`select pg_stat_force_next_flush()`;
    const [row] = await sql<SequentialScanCountRow[]>`
        select seq_scan::text as seq_scan from pg_stat_user_tables
        where schemaname = current_schema() and relname = 'resource_inbox'`;
    return Number(row?.seq_scan);
}
