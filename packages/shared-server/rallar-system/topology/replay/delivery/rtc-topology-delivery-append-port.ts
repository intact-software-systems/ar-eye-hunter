import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { RtcTopologyDeliveryAppend, RtcTopologyDeliveryAppendResult } from './rtc-topology-delivery-contracts.ts';

export interface RtcTopologyDeliveryAppendPort {
    appendOrValidate(
        transaction: PSqlSql,
        computed: RtcTopologyDeliveryAppend
    ): Promise<RtcTopologyDeliveryAppendResult>;
}
