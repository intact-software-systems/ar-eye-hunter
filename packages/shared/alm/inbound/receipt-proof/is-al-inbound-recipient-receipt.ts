import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALInboundEffectIntent } from '../al-inbound-effect-intent.ts';
import type {
    ALInboundUpwardControl,
    ALInboundUpwardControlContext
} from '../control/to-al-inbound-upward-control-work.ts';

/**
 * A counted recipient's own ACK or NACK about the message, which its committer signs: never a repair request nor a
 * control it sends for a child.
 */
export function isALInboundRecipientReceiptIntent(intent: ALInboundEffectIntent, countsSelf: boolean): boolean {
    const { payload } = intent;
    return countsSelf && isALInboundSignedReceiptCarrier(intent.carrier) &&
        (payload.kind === 'send-ack' || payload.kind === 'send-nack') && payload.logicalRecipient.kind === 'self';
}

/** A relay's own ACK when the frozen audience counts the relay; a control it relays for a child is never its own word. */
export function isALInboundRelayRecipientReceipt(
    context: ALInboundUpwardControlContext,
    control: ALInboundUpwardControl,
    carrier: ALDeliveryCarrier
): boolean {
    return isALInboundSignedReceiptCarrier(carrier) && control.kind === 'ack' &&
        control.ack.logicalRecipient.kind === 'self' &&
        context.pending.upwardAudiencePeerIds?.includes(context.relayPeerId) === true;
}

/** Only `rtc` signs: on `ws` the server's ingress authenticates every control's sender. */
function isALInboundSignedReceiptCarrier(carrier: ALDeliveryCarrier): boolean {
    return carrier === 'rtc';
}
