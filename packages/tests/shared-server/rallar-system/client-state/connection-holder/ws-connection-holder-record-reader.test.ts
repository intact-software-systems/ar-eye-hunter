import { describe, it } from 'vitest';

import { createApiV1SchemaPGliteSql, initApiV1SchemaPGliteTemplate } from '../../../../api-v1/create-api-v1-schema-pglite-sql.ts';
import { describeWsConnectionHolderRecordReaderContract } from './test-support/ws-connection-holder-record-reader-contract.ts';

describe('WebSocket connection holder record reads on PGlite', () => {
    initApiV1SchemaPGliteTemplate();

    describeWsConnectionHolderRecordReaderContract({
        test: it,
        openStore: async () => {
            const sql = await createApiV1SchemaPGliteSql();
            return { sql, close: async () => await sql.close() };
        }
    });
});
