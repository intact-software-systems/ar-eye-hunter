import type { ALNackPayload, ALPeerControlMessage } from '../../../al-contracts/al-control.ts';

/**
 * A gap NACK a relay re-sends for a recipient below it (S4ii-R3): the one NACK a hop sends naming another recipient
 * that asks for a repair. Any other NACK naming another recipient asks for nothing and keeps the sender's own rule.
 */
export function isALOutboundRelayedGapNack(
    control: ALPeerControlMessage
): control is Readonly<{ type: 'nack'; payload: ALNackPayload; }> {
    return control.type === 'nack' && control.payload.reason === 'gap' &&
        control.payload.fromPeerId !== control.payload.logicalRecipientPeerId;
}
