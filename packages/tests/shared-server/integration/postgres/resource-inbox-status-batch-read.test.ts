import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { ResourceInboxRowCorruptionError } from '@shared-server/queuebox/postgres/resource-inbox-row-codec.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createResourceInboxTestStorage,
    recordResourceInboxStatements,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres resource inbox status batch read', () => {
    postgresIt('answers the status reads of one turn, from any caller, with one statement and per-key answers', async () => {
        await withStorage(async (storage) => {
            const completed = await seedResourceInboxRow(storage.sql, { resourceId: 'completed', status: EntityStatus.COMPLETED, attempts: 2 });
            const reserved = await seedResourceInboxRow(storage.sql, { resourceId: 'reserved', status: EntityStatus.RESERVED, attempts: 1 });
            const expired = await seedResourceInboxRow(storage.sql, { resourceId: 'expired', status: EntityStatus.COMPLETED, expired: true });
            const absent = { ...completed, resourceId: 'absent' };
            const otherContext = { ...reserved, contextId: 'context-2' };
            const statements: string[] = [];
            const entries = new PSqlResourceInboxEntryRepository(recordResourceInboxStatements(storage.sql, statements), () => new Date());
            const groupWaiterReads = [reserved, absent, completed].map((key) => entries.readStatusAndAttempts(key));
            const clientWaiterReads = [expired, otherContext, reserved].map((key) => entries.readStatusAndAttempts(key));

            expect(await Promise.all([...groupWaiterReads, ...clientWaiterReads])).toEqual([
                { status: 'RESERVED', attempts: 1 },
                undefined,
                { status: 'COMPLETED', attempts: 2 },
                undefined,
                undefined,
                { status: 'RESERVED', attempts: 1 }
            ]);
            expect(statements).toHaveLength(1);
        });
    });

    postgresIt('fails only the read of a corrupt row and answers the others of its statement', async () => {
        await withStorage(async (storage) => {
            const healthy = await seedResourceInboxRow(storage.sql, { resourceId: 'healthy', status: EntityStatus.RESERVED, attempts: 1 });
            const badStatus = await seedResourceInboxRow(storage.sql, { resourceId: 'bad-status', status: EntityStatus.NEW });
            const badAttempts = await seedResourceInboxRow(storage.sql, { resourceId: 'bad-attempts', status: EntityStatus.NEW });
            await storage.sql`update resource_inbox set ri_status = 'UNKNOWN' where ri_resource_id = 'bad-status'`;
            await storage.sql`update resource_inbox set ri_attempts = null where ri_resource_id = 'bad-attempts'`;
            const statements: string[] = [];
            const entries = new PSqlResourceInboxEntryRepository(recordResourceInboxStatements(storage.sql, statements), () => new Date());

            const [badStatusRead, healthyRead, badAttemptsRead] = await Promise.allSettled(
                [badStatus, healthy, badAttempts].map((key) => entries.readStatusAndAttempts(key))
            );

            expect(healthyRead).toEqual({ status: 'fulfilled', value: { status: 'RESERVED', attempts: 1 } });
            expect(badStatusRead.status === 'rejected' && badStatusRead.reason).toBeInstanceOf(ResourceInboxRowCorruptionError);
            expect(badAttemptsRead.status === 'rejected' && badAttemptsRead.reason).toBeInstanceOf(ResourceInboxRowCorruptionError);
            expect(statements).toHaveLength(1);
        });
    });

    postgresIt('reads every key of one turn in one statement through the unique key', async () => {
        await withStorage(async (storage) => {
            await storage.sql`
                insert into resource_inbox (ri_resource_id, ri_topic_id, ri_resource, ri_type_id, ri_status,
                    fk_ext_bank_id, system_date, created_by, created_ts, expire_ts, ri_attempts)
                select 'request-' || series, 'app-inbox.test', '{}', 'APP_INBOX', 'NEW', 'context-' || (series % 50),
                    '2026-10-21', 'server-1', (now() at time zone 'UTC'), (now() at time zone 'UTC') + interval '1 day', 0
                from generate_series(1, 5000) as series`;
            await storage.sql`analyze resource_inbox`;
            const keys = [1, 2, 3].map((series) => ({
                topicId: 'app-inbox.test',
                resourceId: `request-${series}`,
                contextId: `context-${series % 50}`
            }));
            const explained: string[] = [];
            const entries = new PSqlResourceInboxEntryRepository(toExplainingSql(storage.sql, explained), () => new Date());

            await Promise.all(keys.map((key) => entries.readStatusAndAttempts(key)));

            expect(explained).toHaveLength(1);
            expect(explained[0]).toContain('resource_inbox_unique_k');
            expect(explained[0]).not.toContain('Seq Scan on resource_inbox');
        });
    });
});

async function withStorage(verify: (storage: ResourceInboxTestStorage) => Promise<void>): Promise<void> {
    const storage = await createResourceInboxTestStorage('resource_inbox_status_batch');
    try {
        await verify(storage);
    }
    finally {
        await storage.close();
    }
}

/** Runs each statement under `explain` instead, keeps the plan text, and answers no rows. */
function toExplainingSql(source: PSqlSql, explained: string[]): PSqlSql {
    function explaining<Result>(strings: TemplateStringsArray, ...values: readonly PSqlParameter[]): Promise<Result>;
    function explaining(values: readonly PSqlParameter[]): object;
    function explaining<Result>(
        stringsOrValues: TemplateStringsArray | readonly PSqlParameter[],
        ...values: readonly PSqlParameter[]
    ): Promise<Result> | object {
        if (!Object.hasOwn(stringsOrValues, 'raw')) {
            return source(stringsOrValues as readonly PSqlParameter[]);
        }
        const strings = stringsOrValues as TemplateStringsArray;
        const explainStrings = [`explain ${strings[0]}`, ...strings.slice(1)];
        const template = Object.assign(explainStrings, { raw: explainStrings });
        return source<{ 'QUERY PLAN': string; }[]>(template, ...values).then((plan) => {
            explained.push(plan.map((row) => row['QUERY PLAN']).join('\n'));
            return [] as Result;
        });
    }
    return Object.assign(explaining, { begin: source.begin.bind(source) });
}
