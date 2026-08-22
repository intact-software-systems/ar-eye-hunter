import type { PSqlTransactionSql } from '../../../postgres/PostgresSqlClient.ts';
import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryAppendResult
} from './rtc-topology-delivery-contracts.ts';

export interface RtcTopologyDeliveryAppendPort {
    appendOrValidate(
        transaction: PSqlTransactionSql,
        input: RtcTopologyDeliveryAppendInput
    ): Promise<RtcTopologyDeliveryAppendResult>;
}
