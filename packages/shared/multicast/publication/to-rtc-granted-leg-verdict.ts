import type { ALDeliveryAdmissionVerdict } from '../../alm/delivery/al-delivery-lifecycle.ts';
import type { RtcCarrierGapAdmission } from '../compute-rtc-outbound-carrier-availability.ts';
import type { RtcSignedPublicationCarrier } from './rtc-signed-publication-carrier.ts';

/**
 * A granted leg's verdict. The origin's `unauthorized` judgement of the addressee is terminal on a leg with no fallback
 * carrier; on a leg with one (`hand-over`) it answers `no-route`, so the fallback carrier takes the send and its server
 * decides from its live audience, which a stale cached snapshot may not match. An `unsupported` leg is refused as it is.
 */
export function toRtcGrantedLegVerdict(
    refusal: RtcSignedPublicationCarrier.LegRefusal,
    carrierGap: RtcCarrierGapAdmission
): Extract<ALDeliveryAdmissionVerdict, { kind: 'refused' | 'unroutable'; }> {
    const { reason, detail } = refusal;
    return reason === 'unauthorized' && carrierGap === 'hand-over'
        ? { kind: 'unroutable', reason: 'no-route', detail }
        : { kind: 'refused', reason, detail };
}
