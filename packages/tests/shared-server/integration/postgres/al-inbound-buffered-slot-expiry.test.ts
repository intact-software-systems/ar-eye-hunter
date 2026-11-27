import { afterAll, beforeAll, describe, expect } from 'vitest';

import { describeALInboundBufferedSlotExpiryContract } from '../../../shared/alm/inbound/al-inbound-buffered-slot-expiry-contract.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl,
    type PostgresSql
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { createPostgresInboundBackendStores } from './test-support/create-postgres-inbound-admission-store.ts';
import {
    deletePostgresRunRows,
    NO_POSTGRES_RUN_ROWS,
    readPostgresRunRowCounts
} from './test-support/delete-postgres-run-rows.ts';

const RUN_ID = `al-inbound-buffered-slot-expiry-${crypto.randomUUID()}`;

// Each read is its own statement here, so a chain's slot read and its message read see the store at two moments.
describe.skipIf(process.env.RALLAR_POSTGRES_INTEGRATION !== '1')('PostgreSQL inbound buffered slot expiry', () => {
    let sql: PostgresSql | undefined;

    beforeAll(async () => {
        sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
    });

    afterAll(async () => {
        if (sql !== undefined) {
            try {
                await deletePostgresRunRows(sql, RUN_ID);
                expect(await readPostgresRunRowCounts(sql, RUN_ID)).toEqual(NO_POSTGRES_RUN_ROWS);
            }
            finally {
                await sql.end();
            }
        }
    });

    describeALInboundBufferedSlotExpiryContract(
        'PostgreSQL',
        async (namespace) => createPostgresInboundBackendStores(sql!, `${RUN_ID}-${namespace}`)
    );
});
