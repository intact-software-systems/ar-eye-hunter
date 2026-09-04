import type {
    RtcTopologyDeliveryLogEntry,
    RtcTopologyDeliveryPublicationReadInput
} from './rtc-topology-delivery-contracts.ts';

export interface RtcTopologyDeliveryPublicationReader {
    findPublicationDelivery(
        input: RtcTopologyDeliveryPublicationReadInput
    ): Promise<RtcTopologyDeliveryLogEntry | undefined>;
}
