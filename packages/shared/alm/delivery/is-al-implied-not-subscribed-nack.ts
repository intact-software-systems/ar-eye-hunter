import type { ALAckPayload } from '../../al-contracts/al-control.ts';
import { isALRecipientConfirmationAck } from './is-al-recipient-confirmation-ack.ts';

/**
 * The hop-end of a frozen recipient that confirms nobody stands for its `not-subscribed` NACK while the row still owes
 * that recipient, so a lost NACK still records it outside: at a relay's row and at the origin's receipt, whether the
 * recipient sent it itself or a relay forwarded it.
 */
export function isALImpliedNotSubscribedNack(ack: ALAckPayload, owedRecipientPeerIds: readonly string[]): boolean {
    return !isALRecipientConfirmationAck(ack) && owedRecipientPeerIds.includes(ack.logicalRecipientPeerId);
}
