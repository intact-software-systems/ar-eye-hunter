import { describe, it } from 'vitest';

import { describeWsConnectionHolderRecordReaderContract } from '../../rallar-system/client-state/connection-holder/test-support/ws-connection-holder-record-reader-contract.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('WebSocket connection holder record reads on PostgreSQL', () => {
    describeWsConnectionHolderRecordReaderContract({
        test: postgresIt,
        openStore: async () => {
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            return { sql, close: async () => await sql.end() };
        }
    });
});
