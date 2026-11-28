import { describe, expect, it } from 'vitest';

import { readRtcTopologyDeliveryStreamLease } from '@shared-server/rallar-system/topology/replay/postgres/read-rtc-topology-delivery-stream-lease.ts';
import { createApiV1SchemaPGliteSql, initApiV1SchemaPGliteTemplate } from '../../../../../api-v1/create-api-v1-schema-pglite-sql.ts';
import { createLifecycleSql } from '../../../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';
import { describeRtcTopologyDeliveryStreamLeaseContract } from './test-support/rtc-topology-delivery-stream-lease-contract.ts';

describe('RTC topology delivery stream lease on PGlite', () => {
    initApiV1SchemaPGliteTemplate();

    describeRtcTopologyDeliveryStreamLeaseContract({
        test: it,
        openStore: async () => {
            const sql = await createApiV1SchemaPGliteSql();
            return { sql, close: async () => await sql.close() };
        }
    });

    it('refuses an id that is not a UUID before any statement runs', async () => {
        let statementCount = 0;
        const sql = createLifecycleSql(async () => {
            statementCount += 1;
            return [];
        }, async () => {});

        await expect(readRtcTopologyDeliveryStreamLease(sql, 'not-a-uuid')).rejects.toThrow(TypeError);
        expect(statementCount).toBe(0);
    });
});
