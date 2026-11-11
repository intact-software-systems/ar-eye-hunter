import type { ALAckPayload, ALNackPayload, ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import { isSameSignatureProof } from '../../../signature/signature-proof.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';

/** The child controls a relay row admitted before: its ACKs and its outside-audience NACKs. */
export interface ALReceiptStatementHistory {
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
}

/** One statement about one recipient: the same proof identity, or both that recipient's own word on its own channel. */
export function isALSameReceiptStatement(
    prior: ALAckPayload | ALNackPayload,
    control: ALAckPayload | ALNackPayload
): boolean {
    return prior.logicalRecipientPeerId === control.logicalRecipientPeerId &&
        (isSameSignatureProof(prior.proof, control.proof) || (isALOwnWord(prior) && isALOwnWord(control)));
}

/** A stored ACK that confirms `control`'s recipient (`isALRecipientConfirmationAck`) and is the same statement as `control`. */
export function hasALConfirmedStatement(
    acks: readonly ALAckPayload[],
    control: ALAckPayload | ALNackPayload
): boolean {
    return acks.some((prior) => isALRecipientConfirmationAck(prior) && isALSameReceiptStatement(prior, control));
}

/**
 * The row records `control`'s recipient outside by the same statement: the recipient is on `pending.outsideAudiencePeerIds`, and a stored
 * control that records it outside (an outside-audience NACK of the history, or an ACK that confirms nobody) is the same statement as
 * `control`, or the history holds none such any more, so the recipient alone decides.
 */
export function hasALOutsideStatement(
    pending: ALPendingAckSnapshot,
    history: ALReceiptStatementHistory,
    control: ALAckPayload | ALNackPayload
): boolean {
    const recipientPeerId = control.logicalRecipientPeerId;
    if (!pending.outsideAudiencePeerIds.includes(recipientPeerId)) {
        return false;
    }
    const recorders = [
        ...history.nacks,
        ...history.acks.filter((prior) => !isALRecipientConfirmationAck(prior))
    ].filter((prior) => prior.logicalRecipientPeerId === recipientPeerId);
    return recorders.length === 0 || recorders.some((prior) => isALSameReceiptStatement(prior, control));
}

function isALOwnWord(control: ALAckPayload | ALNackPayload): boolean {
    return control.fromPeerId === control.logicalRecipientPeerId;
}
