import type { ALAckPayload } from '../../al-contracts/al-control.ts';

/** Whether an ACK speaks for a recipient's delivery: every ACK but the hop completion of one that delivered nothing. */
export function isALRecipientConfirmationAck(ack: ALAckPayload): boolean {
    return ack.status !== 'subtree-complete-not-subscribed';
}
