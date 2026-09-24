import type { Sql } from 'postgres';

export interface StateWritePostgresCounters {
    sharedBufferHits: number;
    sharedBufferReads: number;
    walLsn: string;
}

export async function readStateWritePostgresCounters(
    sql: Sql
): Promise<StateWritePostgresCounters> {
    const rows = await sql<{
        shared_buffer_hits: number | string;
        shared_buffer_reads: number | string;
        wal_lsn: string;
    }[]>`
    select blks_hit as shared_buffer_hits,
           blks_read as shared_buffer_reads,
           pg_current_wal_lsn()::text as wal_lsn
    from pg_stat_database
    where datname = current_database()
  `;
    const row = rows[0];
    if (!row) {
        throw new Error('pg_stat_database did not return the current database');
    }
    return {
        sharedBufferHits: Number(row.shared_buffer_hits),
        sharedBufferReads: Number(row.shared_buffer_reads),
        walLsn: row.wal_lsn
    };
}

export type ReadStateWriteWalDifferenceInput = Readonly<{
    sql: Sql;
    before: string;
    after: string;
}>;

export async function readStateWriteWalDifference({
    sql,
    before,
    after
}: ReadStateWriteWalDifferenceInput): Promise<number> {
    const rows = await sql<{ wal_bytes: number | string; }[]>`
    select pg_wal_lsn_diff(${after}::pg_lsn, ${before}::pg_lsn)::float8 as wal_bytes
  `;
    return Math.max(0, Number(rows[0]?.wal_bytes ?? 0));
}

export function startStateWriteLockWaitSampler(
    sql: Sql,
    applicationNamePrefix: string
): Readonly<{ stop(): Promise<number>; }> {
    let stopped = false;
    let lockWaitMs = 0;
    const running = (async () => {
        let previousAt = performance.now();
        while (!stopped) {
            const rows = await sql<{ waiting: number | string; }[]>`
        select count(*)::int as waiting
        from pg_stat_activity
        where application_name like ${`${applicationNamePrefix}%`}
          and wait_event_type = 'Lock'
      `;
            const now = performance.now();
            lockWaitMs += Number(rows[0]?.waiting ?? 0) * (now - previousAt);
            previousAt = now;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    })();
    return {
        stop: async () => {
            stopped = true;
            await running;
            return lockWaitMs;
        }
    };
}

export async function assertStateWriteSchemaReady(sql: Sql): Promise<void> {
    const rows = await sql<{
        runtime_state_store: string | null;
    }[]>`
    select to_regclass('runtime_state_store')::text as runtime_state_store
  `;
    const row = rows[0];
    if (!row?.runtime_state_store) {
        throw new Error('PostgreSQL schema is missing; run npm run db:migrate before the benchmark');
    }
}
