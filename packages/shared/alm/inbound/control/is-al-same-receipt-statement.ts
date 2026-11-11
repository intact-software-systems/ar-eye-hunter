import type { ALAckPayload, ALNackPayload, ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import {
    isALSameReceiptProofContent,
    type ALReceiptControl
} from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isSameSignatureProof } from '../../../signature/signature-proof.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';

/** The child controls a relay row admitted before: its ACKs and its outside-audience NACKs. */
export interface ALReceiptStatementHistory {
    readonly acks: readonly ALAckPayload[];
    readonly nacks: readonly ALNackPayload[];
}

/**
 * One statement about one recipient: one proof over one signed content (two absent proofs whatever the content), or
 * both that recipient's own word on its own channel. A relay verifies nothing, so a proof alone never makes two
 * contents one statement: a copied proof over another content is its own statement, which the origin judges.
 */
export function isALSameReceiptStatement(
    prior: ALAckPayload | ALNackPayload,
    control: ALAckPayload | ALNackPayload
): boolean {
    return prior.logicalRecipientPeerId === control.logicalRecipientPeerId &&
        (isSameProofStatement(prior, control) || (isALOwnWord(prior) && isALOwnWord(control)));
}

/**
 * A stored ACK that confirms `control`'s recipient (`isALRecipientConfirmationAck`) and is the same statement as
 * `control`.
 */
export function hasALConfirmedStatement(
    acks: readonly ALAckPayload[],
    control: ALAckPayload | ALNackPayload
): boolean {
    return acks.some((prior) => isALRecipientConfirmationAck(prior) && isALSameReceiptStatement(prior, control));
}

/**
 * The row records `control`'s recipient outside by the same statement: the recipient is on
 * `pending.outsideAudiencePeerIds`, and a stored control that records it outside (an outside-audience NACK of the
 * history, or an ACK that confirms nobody) is the same statement as `control`, or the history holds none such any
 * more, so the recipient alone decides.
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

/** A control its recipient sent on its own channel: the one kind a relay heard from the recipient itself. */
export function isALOwnWord(control: ALAckPayload | ALNackPayload): boolean {
    return control.fromPeerId === control.logicalRecipientPeerId;
}

function isSameProofStatement(prior: ALAckPayload | ALNackPayload, control: ALAckPayload | ALNackPayload): boolean {
    return isSameSignatureProof(prior.proof, control.proof) &&
        (prior.proof === null || isALSameReceiptProofContent(toReceiptControl(prior), toReceiptControl(control)));
}

/** Only an ACK carries `ackedMsgId`; the strict decoders admit no other key. */
function toReceiptControl(payload: ALAckPayload | ALNackPayload): ALReceiptControl {
    return 'ackedMsgId' in payload ? { type: 'ack', payload } : { type: 'nack', payload };
}
