import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { isALCountedRecipient } from '../../delivery/resolve-al-counted-recipient-peer-ids.ts';
import { resolveALDeliveryReceiptAlgo } from '../../delivery/resolve-al-delivery-receipt-algo.ts';
import type { ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';

/** What the relay's mark rule reads of one upward control and the row it answers for. */
export interface ALInboundRelayReceiptMark {
    /** A forwarded child control already carries its author's proof, or none, and is never signed again. */
    readonly controlKind: 'own-ack' | 'forwarded';
    readonly carrier: ALDeliveryCarrier;
    readonly relayPeerId: string;
    readonly upwardAudiencePeerIds: readonly string[] | undefined;
}

/**
 * How this peer stands toward the message's receipt: the receipt counts it, the message asks for no receipt, or
 * neither. The plan decides whether it counts: a plan that refuses the message plans no receipt of its own
 * (`ack.algo: 'none'`).
 */
export type ALInboundReceiptStanding = 'counted' | 'unreceipted' | 'uncounted';

/** What a commit does with a control whose signature failed: leaves it out, or sends it unsigned. */
export type ALInboundSignFailurePolicy = 'leave-out' | 'send-unsigned';

export function resolveALInboundReceiptStanding(
    msg: ALMessage,
    plan: ALMessageHandlingPlan,
    selfPeerId: string
): ALInboundReceiptStanding {
    if (isALCountedRecipient(msg, plan.effective.ack.algo, selfPeerId)) {
        return 'counted';
    }
    return isALInboundUnreceiptedMessage(msg) ? 'unreceipted' : 'uncounted';
}

/**
 * A counted recipient's own ACK or NACK about the message, which its committer signs: never a repair request nor a
 * control it forwards for a child. On a track that asks for no receipt it signs its gap NACK, the one control a relay
 * forwards for it whose repair the origin charges to it (ruling 19).
 */
export function isALInboundRecipientReceiptIntent(
    intent: ALInboundEffectIntent,
    standing: ALInboundReceiptStanding
): boolean {
    const { payload } = intent;
    if (!isALInboundSignedReceiptCarrier(intent.carrier)) {
        return false;
    }
    return standing === 'counted'
        ? payload.kind === 'send-ack' || payload.kind === 'send-nack'
        : standing === 'unreceipted' && payload.kind === 'send-nack' && payload.reason === 'gap';
}

/**
 * An unreceipted message's gap NACK goes unsigned when its signature fails, since the carrier authenticates a direct
 * request; a receipted message's control is left out, since its origin counts only a signed one. Unknown, it is left
 * out.
 */
export function resolveALInboundSignFailurePolicy(msg: ALMessage | undefined): ALInboundSignFailurePolicy {
    return msg !== undefined && isALInboundUnreceiptedMessage(msg) ? 'send-unsigned' : 'leave-out';
}

function isALInboundUnreceiptedMessage(msg: ALMessage): boolean {
    return resolveALDeliveryReceiptAlgo(msg) === 'none';
}

/** A relay's own ACK when the frozen audience counts the relay; a control it forwards for a child is never its own word. */
export function isALInboundRelayRecipientReceipt(mark: ALInboundRelayReceiptMark): boolean {
    return isALInboundSignedReceiptCarrier(mark.carrier) && mark.controlKind === 'own-ack' &&
        mark.upwardAudiencePeerIds?.includes(mark.relayPeerId) === true;
}

/** Only `rtc` signs: on `ws` the server's ingress authenticates every control's sender. */
function isALInboundSignedReceiptCarrier(carrier: ALDeliveryCarrier): boolean {
    return carrier === 'rtc';
}
