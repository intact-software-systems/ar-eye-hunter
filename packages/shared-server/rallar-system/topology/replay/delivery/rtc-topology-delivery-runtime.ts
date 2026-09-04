import type { RtcTopologyDeliveryAppendPort } from './rtc-topology-delivery-append-port.ts';
import type { RtcTopologyDeliveryPublicationReader } from './rtc-topology-delivery-publication-reader.ts';

export interface RtcTopologyDeliveryRuntime {
    readonly publisherStreamId: string;
    readonly reader: RtcTopologyDeliveryPublicationReader;
    readonly append: RtcTopologyDeliveryAppendPort;
}
