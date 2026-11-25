import type { ALNackPayload } from '../../../al-contracts/al-control.ts';
import type { ALControlAdmissionRead } from '../compute-al-outbound-control-admission.ts';
import { toALOutboundRefusalIssue, type ALOutboundControlIssue } from './read-al-outbound-recipient-proof.ts';
import { validateALOutboundRelayedNack } from './validate-al-outbound-relayed-nack.ts';

/**
 * An outside-audience NACK (`not-subscribed`, `before-entry`) speaks for its logical recipient, as an ACK does: under a
 * logical receipt whichever hop relayed it, under `hop` and `subtree` only from the recipient itself. It moves a
 * recipient the receipt still owes outside the audience, and is refused for anyone else, and after the message's
 * deadline (PL9, PL16).
 */
export function validateALOutboundOutsideAudienceNack(
    read: ALControlAdmissionRead,
    nack: ALNackPayload
): readonly ALOutboundControlIssue[] {
    return [
        ...validateALOutboundRelayedNack(read, nack),
        ...(read.sent !== undefined && read.sent.reference.expiresAtMs <= read.nowMs
            ? [toALOutboundRefusalIssue(`AL ${nack.reason} NACK arrived after its message deadline`)]
            : [])
    ];
}
