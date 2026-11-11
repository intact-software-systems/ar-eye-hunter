import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
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
