import {
    describe,
    expect,
    it
} from 'vitest';

import { createStateWriteBenchmarkSql } from '../../../../../apps/api-v1/scripts/perf/create-state-write-benchmark-sql.ts';
import { requirePostgresDatabaseUrl } from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('state-write benchmark PostgreSQL observations', () => {
    postgresIt('writes Date parameters as UTC timestamps without losing exact text observations', async () => {
        const sql = createStateWriteBenchmarkSql({
            databaseUrl: requirePostgresDatabaseUrl(),
            maxConnections: 1,
            applicationName: 'state-write-date-parameter-test'
        });
        try {
            const rows = await sql.begin(async (transaction) => {
                await transaction`set local time zone 'America/New_York'`;
                await transaction`create temporary table timestamp_parameters (
                    observed timestamp(6) not null
                ) on commit drop`;
                await transaction`insert into timestamp_parameters values (${new Date('2026-11-13T00:30:12.123Z')})`;
                await transaction`insert into timestamp_parameters values (${'2026-11-13 00:30:12.123456'})`;
                return await transaction`select observed from timestamp_parameters order by observed`;
            });

            expect([...rows]).toEqual([
                { observed: '2026-11-13 00:30:12.123' },
                { observed: '2026-11-13 00:30:12.123456' }
            ]);
        }
        finally {
            await sql.end();
        }
    });

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
