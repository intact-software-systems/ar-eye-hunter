import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALMessageRejection } from '../../../al-contracts/al-message-persistence-validation.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { validateALOutboundRelayedNack } from './validate-al-outbound-relayed-nack.ts';

/**
 * An outside-audience NACK (`not-subscribed`, `before-entry`) speaks for its logical recipient, as an ACK does,
 * whichever hop relayed it: it moves a recipient the receipt still owes outside the audience, and is refused for
 * anyone else, and after the message's deadline (PL9, PL16).
 */
export function validateALOutboundOutsideAudienceNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALMessageRejection[] {
    return [
        ...validateALOutboundRelayedNack(read, nack),
        ...(read.sent !== undefined && read.sent.reference.expiresAtMs <= read.nowMs
            ? [{ code: 'unauthorized' as const, message: `AL ${nack.reason} NACK arrived after its message deadline` }]
            : [])
    ];
}
