import postgres, { type Sql } from 'postgres';

import { createPostgresTimestampWithoutTimeZoneTextType } from '@shared-server/postgres/postgres-timestamp-without-time-zone.ts';

export interface StateWriteBenchmarkSqlInput {
    readonly databaseUrl: string;
    readonly maxConnections: number;
    readonly applicationName: string;
}

export function createStateWriteBenchmarkSql(input: StateWriteBenchmarkSqlInput): Sql {
    return postgres(input.databaseUrl, {
        max: input.maxConnections,
        connection: { application_name: input.applicationName },
        types: {
            timestampWithoutTimeZone: createPostgresTimestampWithoutTimeZoneTextType()
        }
    });
}
