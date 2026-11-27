import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { RtcTopologyDeliveryStreamLease } from '../delivery/rtc-topology-delivery-contracts.ts';
import { assertRtcTopologyDeliveryStreamId } from '../delivery/rtc-topology-delivery-validation.ts';

/**
 * Whether the stream holds a live lease, by the renewal's own predicate on the database clock: a stream read live
 * could still renew at that instant, and one read not live never can again.
 */
export async function readRtcTopologyDeliveryStreamLease(
    sql: PSqlSql,
    streamId: string
): Promise<RtcTopologyDeliveryStreamLease> {
    assertRtcTopologyDeliveryStreamId(streamId);
    const [row] = await sql<Array<{ live: boolean; }>>`
        select exists (
            select 1
            from rtc_topology_delivery_stream
            where stream_id = ${streamId}
              and lease_expires_at > clock_timestamp()
        ) as live
    `;
    return { streamId, live: row?.live === true };
}
