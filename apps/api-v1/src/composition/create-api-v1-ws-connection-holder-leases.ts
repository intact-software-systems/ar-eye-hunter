import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { WsConnectionHolderLeaseReader } from '@shared-server/rallar-system/client-state/connection-holder/ws-connection-holder-lease.ts';
import { readRtcTopologyDeliveryStreamLease } from '@shared-server/rallar-system/topology/replay/postgres/read-rtc-topology-delivery-stream-lease.ts';

/**
 * A connection holder is the process whose topology delivery stream the holder id names, so its liveness lease is
 * that stream's lease: one lease and one fence. This composition is the only place that knows both features.
 */
export function createApiV1WsConnectionHolderLeases(database: PSqlSql): WsConnectionHolderLeaseReader {
    return {
        readHolderLease: async (holderId) => ({
            holderId,
            live: (await readRtcTopologyDeliveryStreamLease(database, holderId)).live
        })
    };
}
