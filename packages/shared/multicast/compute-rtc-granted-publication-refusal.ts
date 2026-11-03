import type { ALMessage } from '../al-contracts/al-contract.ts';
import { isALLogicalReceiptMode } from '../al-contracts/validate-al-ack-support.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';
import { Either } from '../resilience/Either.ts';

export const RTC_GRANTED_PUBLICATION_REFUSALS = {
    notMulticast: 'RTC carries a granted publication only as a room multicast.',
    receipt: 'RTC carries a granted publication only without a receipt (ack: none).',
    unsigned: 'RTC carries a granted publication only signed by its origin.'
} as const;

/** The shape a granted publication must have before its origin signs it; `undefined` when RTC can carry it. */
export function resolveRtcGrantedPublicationShapeRefusal(msg: ALMessage): string | undefined {
    if (msg.targets?.mode !== 'multicast') {
        return RTC_GRANTED_PUBLICATION_REFUSALS.notMulticast;
    }
    const qosAck = msg.qos?.ack?.algo;
    return msg.delivery?.ack === 'none' && (qosAck === undefined || !isALLogicalReceiptMode(qosAck))
        ? undefined
        : RTC_GRANTED_PUBLICATION_REFUSALS.receipt;
}

/**
 * RTC carries a granted publication only as a signed room multicast without a receipt; any other is refused as
 * unsupported, the refusal a fallback carrier takes over. Its shape is judged, and the refusal named, by the targets
 * its sender gave, never by the multicast the origin froze them to.
 */
export function computeRtcGrantedPublicationRefusal(
    msg: ALMessage,
    original: ALMessage
): Either<ALOutboundDispatchPlan<ALOutboundTransportMessage>, ALMessage> {
    const refusal = resolveRtcGrantedPublicationShapeRefusal(original) ??
        (msg.proof === undefined ? RTC_GRANTED_PUBLICATION_REFUSALS.unsigned : undefined);
    return refusal === undefined
        ? Either.ofRight(msg)
        : Either.ofLeft({
            msg: { ...msg, targets: original.targets },
            dropReason: refusal,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
}
