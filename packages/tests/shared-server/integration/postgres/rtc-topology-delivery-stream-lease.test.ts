import { describe, it } from 'vitest';

import {
    describeRtcTopologyDeliveryStreamLeaseContract,
    describeRtcTopologyDeliveryStreamLeaseDatabaseClock
} from '../../rallar-system/topology/replay/delivery/test-support/rtc-topology-delivery-stream-lease-contract.ts';
import {
    createRuntimeStatePostgresSql,
    requirePostgresDatabaseUrl
} from '../../runtime-state/postgres/postgres-runtime-state-client-fixtures.ts';

const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

describe('RTC topology delivery stream lease on PostgreSQL', () => {
    const store = {
        test: postgresIt,
        openStore: async () => {
            const sql = await createRuntimeStatePostgresSql(requirePostgresDatabaseUrl());
            return { sql, close: async () => await sql.end() };
        }
    };

    describeRtcTopologyDeliveryStreamLeaseContract(store);
    describeRtcTopologyDeliveryStreamLeaseDatabaseClock(store);
});
