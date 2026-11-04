import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';

/**
 * A re-plan of a stored message its carrier refuses because the sender holds no `publish` any more ends the message
 * (S3-R8), as the trusted server's own `no-publish-grant` refusal of a send does: a revoke is a terminal policy fact, so
 * the handle settles `rejected`. Every other re-plan refusal keeps its silent drop.
 */
export function resolveALOutboundReplanRefusalSettlement(
    msg: ALMessage,
    verdict: ALDeliveryAdmissionVerdict
): ALOutboundSettlementFact | undefined {
    return verdict.kind === 'refused' && verdict.reason === 'no-publish-grant'
        ? { kind: 'admission', msgId: msg.id.msgId, traceId: msg.id.traceId, verdict, trackedReceiptAlgo: 'none' }
        : undefined;
}
