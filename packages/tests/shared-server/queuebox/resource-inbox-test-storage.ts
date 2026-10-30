import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { EntityStatus, Key } from '@shared/queuebox/ResourceEntry.ts';

import { API_V1_IN_MEMORY_SCHEMA_URL } from '../../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient } from '../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { toPSqlSql } from '../integration/postgres/test-support/postgres-sql-adapter.ts';

export interface ResourceInboxTestStorage {
    readonly sql: PSqlSql;
    close(): Promise<void>;
}

export interface ResourceInboxTestRow {
    readonly resourceId: string;
    readonly typeId?: string;
    readonly status: EntityStatus;
    readonly attempts?: number;
    readonly startedAgoSeconds?: number;
    readonly endedAgoSeconds?: number;
    readonly nextInSeconds?: number;
    readonly expired?: boolean;
}

export type ResourceInboxTestBackend = 'memory' | 'postgres';

/**
 * The API-v1 schema on PGlite, or on the integration PostgreSQL in its own schema, through a pool of `maxConnections`
 * there. Without an explicit backend, PostgreSQL is chosen when `RALLAR_POSTGRES_INTEGRATION=1`.
 */
export async function createResourceInboxTestStorage(
    schemaPrefix: string,
    maxConnections = 1,
    backend: ResourceInboxTestBackend = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? 'postgres' : 'memory'
): Promise<ResourceInboxTestStorage> {
    const schemaSql = await readFile(API_V1_IN_MEMORY_SCHEMA_URL, 'utf8');
    if (backend === 'memory') {
        const sql = createPGliteSqlClient(new PGlite());
        await sql.exec(schemaSql);
        return { sql, close: async () => await sql.close() };
    }
    const schema = `${schemaPrefix}_${crypto.randomUUID().replaceAll('-', '')}`;
    const client = postgres(process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/appdb', {
        max: maxConnections,
        connection: { search_path: schema },
        types: { timestampWithoutTimeZone: createPostgresTimestampWithoutTimeZoneTextType() }
    });
    try {
        await client.unsafe(`create schema "${schema}"`);
        await client.unsafe(schemaSql);
    }
    catch (error) {
        await client.unsafe(`drop schema if exists "${schema}" cascade`);
        await client.end();
        throw error;
    }
    return {
        sql: toPSqlSql(client),
        close: async () => {
            try {
                await client.unsafe(`drop schema "${schema}" cascade`);
            }
            finally {
                await client.end();
            }
        }
    };
}

/** One row in database time: lifecycle timestamps are offsets from the database clock, never client instants. */
export async function seedResourceInboxRow(sql: PSqlSql, row: ResourceInboxTestRow): Promise<Key> {
    const key = { topicId: 'app-inbox.test', resourceId: row.resourceId, contextId: 'context-1' };
    const startedAgoSeconds = row.startedAgoSeconds ?? null;
    const endedAgoSeconds = row.endedAgoSeconds ?? null;
    const nextInSeconds = row.nextInSeconds ?? null;
    await sql`insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
             fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts, start_ts, end_ts, next_ts)
             values (${key.resourceId}, ${key.topicId}, ${JSON.stringify({ resourceId: row.resourceId })},
             ${row.typeId ?? EnqueuedType.APP_INBOX}, ${row.status},
             ${key.contextId}, '2026-10-10', 'server-1', (now() at time zone 'UTC'),
             (now() at time zone 'UTC') + (${row.expired ? -1 : 1} * interval '1 day'), ${row.attempts ?? 0},
             case when ${startedAgoSeconds}::int is null then null
                 else (now() at time zone 'UTC') - (${startedAgoSeconds}::int * interval '1 second') end,
             case when ${endedAgoSeconds}::int is null then null
                 else (now() at time zone 'UTC') - (${endedAgoSeconds}::int * interval '1 second') end,
             case when ${nextInSeconds}::int is null then null
                 else (now() at time zone 'UTC') + (${nextInSeconds}::int * interval '1 second') end)`;
    return key;
}

/** Records every template statement, normalized, plus `begin`/`commit` markers around each transaction. */
export function recordResourceInboxStatements(source: PSqlSql, recorded: string[]): PSqlSql {
    function recording<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function recording(values: readonly PSqlParameter[]): object;
    function recording<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        recorded.push(strings.join('?').replace(/\s+/gu, ' ').trim().toLowerCase());
        return source<Result>(strings, ...values);
    }
    return Object.assign(recording, {
        begin: async <T>(write: (transaction: PSqlSql) => Promise<T>): Promise<T> => {
            recorded.push('begin');
            const result = await source.begin(async (transaction) => await write(recordResourceInboxStatements(transaction, recorded)));
            recorded.push('commit');
            return result;
        }
    });
}
