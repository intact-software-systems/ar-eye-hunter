import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundCommitBundle, ALOutboundMessageReadDto } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import type { ALOutboundComputeIntent } from '../compute-al-outbound-dispatch.ts';
import { toALOutboundEndReceiptBundle } from './to-al-outbound-end-receipt-bundle.ts';

/** A stored message's re-plan as its dispatch read it, and the verdict its plan maps to. */
export interface ResolveALOutboundReplanRefusalBundleInput<TPrepared> {
    readonly read: Pick<ALOutboundMessageReadDto<TPrepared>, 'msg' | 'clientRecord'>;
    readonly verdict: ALDeliveryAdmissionVerdict;
    readonly intent: ALOutboundComputeIntent;
}

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

/**
 * The commit a dequeue or retransmit makes of such a refusal: it ends the receipt under the sender version its decision
 * read, so a same-sender commit since conflicts and the retried work decides again, and its success states the refusal.
 * A first admission commits nothing: the dispatch refuses it at once.
 */
export function resolveALOutboundReplanRefusalBundle<TPrepared>(
    input: ResolveALOutboundReplanRefusalBundleInput<TPrepared>
): ALOutboundCommitBundle<TPrepared> | undefined {
    const { msg, clientRecord } = input.read;
    return input.intent !== 'enqueue' && resolveALOutboundReplanRefusalSettlement(msg, input.verdict) !== undefined
        ? toALOutboundEndReceiptBundle(msg.id.senderId, msg.id.msgId, clientRecord?.version)
        : undefined;
}
