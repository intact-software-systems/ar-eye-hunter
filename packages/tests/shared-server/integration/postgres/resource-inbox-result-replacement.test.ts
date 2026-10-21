import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
    computeResourceInboxResultReplacement,
    writeResourceInboxResultReplacement
} from '@shared-server/queuebox/postgres/resource-inbox-result-replacement.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import { EntityStatus, NEVER_EXPIRE_TS, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('Postgres resource inbox result replacement', () => {
    postgresIt('returns the replaced row\'s identity, not its stored result', async () => {
        const { sql, entry } = await createResultStorage();

        const inserted = await writeResourceInboxResultReplacement(sql, computeResourceInboxResultReplacement(entry));
        const replaced = await writeResourceInboxResultReplacement(
            sql,
            computeResourceInboxResultReplacement({ ...entry, resource: '{"result":"replaced"}' })
        );

        expect(Object.keys(inserted)).toEqual(['ris_row_id']);
        expect(replaced).toEqual(inserted);
        const stored = await new ResourceInboxResultsRepository(sql).findByKey(entry.key);
        expect(stored?.resource).toBe('{"result":"replaced"}');
    });
});

async function createResultStorage(): Promise<Readonly<{ sql: PostgresSql; entry: ResourceEntry; }>> {
    const namespace = crypto.randomUUID();
    const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    onTestFinished(async () => {
        try {
            await sql`delete from resource_inbox_results where fk_ext_bank_id = ${namespace}`;
        }
        finally {
            await sql.end();
        }
    });
    return {
        sql,
        entry: {
            key: { topicId: 'result-replacement', resourceId: 'replaced-result', contextId: namespace },
            typeId: 'RESULT',
            resource: '{"result":"first"}',
            status: EntityStatus.COMPLETED,
            audit: {
                date: Temporal.PlainTime.from('12:00:00'),
                createdBy: 'result-writer',
                createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
                expiryTs: NEVER_EXPIRE_TS
            },
            dequeueAudit: { attempts: 1 }
        }
    };
}
