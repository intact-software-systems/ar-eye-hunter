import { describe, expect, it } from 'vitest';

import { createStateWriteBenchmarkSql } from '../../../../../scripts/perf/create-state-write-benchmark-sql.ts';
import { requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('state-write benchmark PostgreSQL observations', () => {
    postgresIt('preserves a microsecond timestamp through an exact conditional write', async () => {
        const sql = createStateWriteBenchmarkSql({
            databaseUrl: requirePostgresDatabaseUrl(),
            maxConnections: 1,
            applicationName: 'state-write-timestamp-test'
        });
        try {
            const rows = await sql.begin(async (transaction) => {
                await transaction`create temporary table timestamp_observation (
                    observed timestamp(6) not null, value text not null
                ) on commit drop`;
                await transaction`insert into timestamp_observation
                    values (timestamp '2026-09-06 09:35:12.123456', 'original')`;
                const observations = await transaction<Array<{ observed: string; }>>`
                    select observed from timestamp_observation`;
                const observation = observations[0];
                if (observation === undefined) {
                    throw new Error('Expected the inserted timestamp observation');
                }
                return await transaction`update timestamp_observation set value = 'replaced'
                    where observed = ${observation.observed}::timestamp returning value`;
            });

            expect([...rows]).toEqual([{ value: 'replaced' }]);
        }
        finally {
            await sql.end();
        }
    });
});
