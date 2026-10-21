import { describe, expect, it } from 'vitest';

import type { PSqlParameter, PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { PSqlResourceInboxEntryRepository } from '@shared-server/queuebox/postgres/p-sql-resource-inbox-entry-repository.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createResourceInboxTestStorage,
    seedResourceInboxRow,
    type ResourceInboxTestStorage
} from '../../queuebox/resource-inbox-test-storage.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres resource inbox status batch read', () => {
    postgresIt('answers each key in the order asked, absent and expired rows as undefined', async () => {
        await withStorage(async (storage) => {
            const completed = await seedResourceInboxRow(storage.sql, { resourceId: 'completed', status: EntityStatus.COMPLETED, attempts: 2 });
            const reserved = await seedResourceInboxRow(storage.sql, { resourceId: 'reserved', status: EntityStatus.RESERVED, attempts: 1 });
            const expired = await seedResourceInboxRow(storage.sql, { resourceId: 'expired', status: EntityStatus.COMPLETED, expired: true });
            const absent = { ...completed, resourceId: 'absent' };
            const otherContext = { ...reserved, contextId: 'context-2' };
            const entries = new PSqlResourceInboxEntryRepository(storage.sql, () => new Date());

            expect(await entries.readStatusesAndAttempts([reserved, absent, completed, expired, otherContext, reserved])).toEqual([
                { status: 'RESERVED', attempts: 1 },
                undefined,
                { status: 'COMPLETED', attempts: 2 },
                undefined,
                undefined,
                { status: 'RESERVED', attempts: 1 }
            ]);
            expect(await entries.readStatusesAndAttempts([])).toEqual([]);
        });
    });

    postgresIt('reads every key in one statement through the unique key', async () => {
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

            await entries.readStatusesAndAttempts(keys);

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
