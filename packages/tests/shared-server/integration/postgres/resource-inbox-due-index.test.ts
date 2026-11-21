import { describe, expect, it } from 'vitest';

import { createRuntimeStatePostgresSql } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

/**
 * The integration tests build their own schemas from `in-memory-schema.sql`, and `schema.prisma` cannot state a null
 * order: only this read of the migrated schema notices a generated `DROP INDEX resource_inbox_due_ix`.
 */
describe('the migrated resource inbox schema', () => {
    postgresIt('keeps the due index the due page and the due claim read', async () => {
        const sql = await createRuntimeStatePostgresSql(requireDatabaseUrl());
        try {
            const indexes = await sql<ReadonlyArray<{ indexdef: string; }>>`
                select indexdef
                from pg_indexes
                where schemaname = 'public'
                  and indexname = 'resource_inbox_due_ix'
            `;

            expect(indexes.map((index) => index.indexdef)).toEqual([
                'CREATE INDEX resource_inbox_due_ix ON public.resource_inbox USING btree (ri_type_id, ri_status, next_ts NULLS FIRST, ri_row_id)'
            ]);
        }
        finally {
            await sql.end();
        }
    });
});

function requireDatabaseUrl(): string {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error('DATABASE_URL is required when RALLAR_POSTGRES_INTEGRATION=1');
    }
    return databaseUrl;
}
