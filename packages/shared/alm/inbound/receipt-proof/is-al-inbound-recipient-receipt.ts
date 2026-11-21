import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { isALCountedRecipient } from '../../delivery/resolve-al-counted-recipient-peer-ids.ts';
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
 * Whether the message's own receipt counts this peer. Its plan decides: a plan that refuses the message plans no
 * receipt of its own (`ack.algo: 'none'`).
 */
export function isALInboundCountedSelf(msg: ALMessage, plan: ALMessageHandlingPlan, selfPeerId: string): boolean {
    return isALCountedRecipient(msg, plan.effective.ack.algo, selfPeerId);
}

/**
 * A counted recipient's own ACK or NACK about the message, which its committer signs: never a repair request nor a
 * control it forwards for a child.
 */
export function isALInboundRecipientReceiptIntent(intent: ALInboundEffectIntent, countsSelf: boolean): boolean {
    const { payload } = intent;
    return countsSelf && isALInboundSignedReceiptCarrier(intent.carrier) &&
        (payload.kind === 'send-ack' || payload.kind === 'send-nack');
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
