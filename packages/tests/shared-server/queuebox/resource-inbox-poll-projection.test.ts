import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxRowCorruptionError } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { API_V1_IN_MEMORY_SCHEMA_URL } from '../../../../apps/api-v1/src/db/in-memory-schema-bootstrap.ts';
import { createPGliteSqlClient } from '../../../../apps/api-v1/src/db/pglite-sql-adapter.ts';
import { createResourceInboxQueryCapture } from '../../shared/p-sql-resource-inbox-test-harness.ts';
import { toPSqlSql } from '../integration/postgres/test-support/postgres-sql-adapter.ts';

const key: Key = { topicId: 'AppInbox', resourceId: 'request-1', contextId: 'context-1' };
interface ResourceInboxPollTestStorage {
    readonly sql: PSqlSql;
    close(): Promise<void>;
}

let storage: ResourceInboxPollTestStorage;
let sql: PSqlSql;
let repository: PSqlResourceInboxEntryRepository;

beforeAll(async () => {
    storage = await createResourceInboxPollTestStorage();
    sql = storage.sql;
    repository = new PSqlResourceInboxEntryRepository(sql);
});
afterAll(async () => await storage?.close());
beforeEach(async () => await sql`delete from resource_inbox`);

describe('resource inbox poll projection', () => {
    it('reads only status and attempts in one bounded exact-key SQL statement', async () => {
        const capture = createResourceInboxQueryCapture();
        const entries = new PSqlResourceInboxEntryRepository(capture.sql);
        expect(await entries.readStatusAndAttempts(key)).toBeUndefined();
        expect(capture.queries).toEqual([{
            query: 'select ri_status, ri_attempts from resource_inbox where ri_topic_id = and ri_resource_id = and fk_ext_bank_id = and expire_ts > limit 1',
            values: ['AppInbox', 'request-1', 'context-1', expect.any(Date)]
        }]);
    });

    it('isolates every key slot and ignores expired exact-key rows', async () => {
        await writeRow({ ...key, topicId: 'other-topic' }, 'COMPLETED', 4n);
        await writeRow({ ...key, resourceId: 'other-request' }, 'FAILED', 5n);
        await writeRow({ ...key, contextId: 'other-context' }, 'NON_RETRYABLE', 6n);
        expect(await repository.readStatusAndAttempts(key)).toBeUndefined();
        await writeRow(key, 'NEW', 0n);
        expect(await repository.readStatusAndAttempts(key)).toEqual({ status: 'NEW', attempts: 0 });
        await sql`update resource_inbox set expire_ts = (now() at time zone 'UTC') - interval '1 second'
                  where ri_topic_id = ${key.topicId} and ri_resource_id = ${key.resourceId} and fk_ext_bank_id = ${key.contextId}`;
        expect(await repository.readStatusAndAttempts(key)).toBeUndefined();
    });

    it.each(['NEW', 'RESERVED', 'RETRY', 'COMPLETED', 'FAILED', 'NON_RETRYABLE', 'ABORTED', 'PARTITIONED', 'MERGED'] as const)(
        'projects canonical %s and its valid attempts without decoding resource bytes',
        async (status) => {
            await writeRow(key, status, 17n);
            expect(await repository.readStatusAndAttempts(key)).toEqual({ status, attempts: 17 });
        }
    );

    it.each(
        [
            ['unknown status', 'UNKNOWN', 1n],
            ['missing attempts', 'COMPLETED', null],
            ['negative attempts', 'COMPLETED', -1n],
            ['unsafe attempts', 'COMPLETED', 9007199254740992n]
        ] as const
    )('fails closed for %s', async (_label, status, attempts) => {
        await writeRow(key, status, attempts);
        await expect(repository.readStatusAndAttempts(key)).rejects.toBeInstanceOf(ResourceInboxRowCorruptionError);
        const events: RallarTimingEvent[] = [];
        const waiter = new AppInboxResultWaiter({
            statusRepository: repository,
            resultRepository: { findByKey: async () => undefined }
        }, {
            serviceId: 'server-1',
            timing: (event) => events.push(event),
            options: normalizeAppInboxOptions({ phaseTiming: true, waitMaxElapsedMsecs: 0 })
        });
        const result = await waiter.waitForResult({ type: AppInboxType.GROUP_CREATE, ...key, data: null }, key, (value) => value);
        expect(result.left).toMatchObject({ code: 'app-inbox-unavailable', status: 503 });
        expect(events.filter((event) => event.operation === 'wait-poll')).toEqual([
            expect.objectContaining({ status: 'error', details: { type: 'GROUP_CREATE', ...key, queueObservation: 'read-failure' } })
        ]);
    });
});

async function writeRow(key: Key, status: string, attempts: bigint | null): Promise<void> {
    await sql`insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
             fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts)
             values (${key.resourceId}, ${key.topicId}, 'invalid-resource-json', 'APP_INBOX', ${status},
             ${key.contextId}, '2026-10-10', 'server-1', (now() at time zone 'UTC'),
             (now() at time zone 'UTC') + interval '1 day', ${attempts})`;
}

async function createResourceInboxPollTestStorage(): Promise<ResourceInboxPollTestStorage> {
    const schemaSql = await readFile(API_V1_IN_MEMORY_SCHEMA_URL, 'utf8');
    if (process.env.RALLAR_POSTGRES_INTEGRATION !== '1') {
        const sql = createPGliteSqlClient(new PGlite());
        await sql.exec(schemaSql);
        return { sql, close: async () => await sql.close() };
    }
    const schema = `poll_projection_${crypto.randomUUID().replaceAll('-', '')}`;
    const client = postgres(process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/appdb', {
        max: 1,
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
