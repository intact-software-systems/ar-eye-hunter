import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryAppendResult
} from './rtc-topology-delivery-contracts.ts';

export interface RtcTopologyDeliveryAppendPort {
    appendOrValidate(
        transaction: PSqlSql,
        input: RtcTopologyDeliveryAppendInput
    ): Promise<RtcTopologyDeliveryAppendResult>;
}
