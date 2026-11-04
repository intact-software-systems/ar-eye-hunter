import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import type { ALOutboundMessageReadDto } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundSettlementFact } from '../al-outbound-message-runtime.ts';
import type { ALOutboundComputedDto, ALOutboundComputeIntent } from '../compute-al-outbound-dispatch.ts';
import { toALOutboundEndReceiptBundle } from './to-al-outbound-end-receipt-bundle.ts';

/** A dropped plan's computed verdict, and the dispatch read and intent it was decided on. */
export interface ToALOutboundReplanRefusalComputedInput<TPrepared> {
    readonly computed: ALOutboundComputedDto<TPrepared>;
    readonly read: Pick<ALOutboundMessageReadDto<TPrepared>, 'msg' | 'clientRecord'>;
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
 * A first admission commits nothing: the dispatch refuses it at once. Any other drop keeps its verdict alone.
 */
export function toALOutboundReplanRefusalComputed<TPrepared>(
    input: ToALOutboundReplanRefusalComputedInput<TPrepared>
): ALOutboundComputedDto<TPrepared> {
    const { computed, read } = input;
    if (
        input.intent === 'enqueue' || resolveALOutboundReplanRefusalSettlement(read.msg, computed.verdict) === undefined
    ) {
        return computed;
    }
    const bundle = toALOutboundEndReceiptBundle<TPrepared>(
        read.msg.id.senderId,
        read.msg.id.msgId,
        read.clientRecord?.version
    );
    return { ...computed, msg: read.msg, bundle };
}
