import type { ALAckPayload, ALNackPayload, ALPendingAckSnapshot } from '../../../al-contracts/al-control.ts';
import {
    isALOwnWord,
    toALReceiptProofSigningInput,
    type ALReceiptControl
} from '../../../al-contracts/receipt-proof/al-receipt-proof.ts';
import { isSameSignatureProof } from '../../../signature/signature-proof.ts';
import { isALRecipientConfirmationAck } from '../../delivery/is-al-recipient-confirmation-ack.ts';

/** A control and its signed content, encoded at most once however many scans compare it. */
export interface ALReceiptStatementSubject {
    readonly control: ALReceiptControl;
    readonly readSignedContent: () => string;
}

/** The child controls a relay row admitted before: its ACKs and its outside-audience NACKs. */
export interface ALReceiptStatementHistory {
    readonly acks: readonly ALReceiptStatementSubject[];
    readonly nacks: readonly ALReceiptStatementSubject[];
}

/** Only an ACK carries `ackedMsgId`; the strict decoders admit no other key. */
export function toALReceiptStatementSubject(payload: ALAckPayload | ALNackPayload): ALReceiptStatementSubject {
    return toSubject('ackedMsgId' in payload ? { type: 'ack', payload } : { type: 'nack', payload });
}

export function toALReceiptStatementHistory(
    acks: readonly ALAckPayload[],
    nacks: readonly ALNackPayload[]
): ALReceiptStatementHistory {
    return { acks: acks.map(toALReceiptStatementSubject), nacks: nacks.map(toALReceiptStatementSubject) };
}

/**
 * One statement about one recipient: one proof over one signed content (two absent proofs whatever the content), or
 * both that recipient's own word on its own channel. A relay verifies nothing, so a proof alone never makes two
 * contents one statement: a copied proof over another content is its own statement, which the origin judges.
 */
export function isALSameReceiptStatement(
    prior: ALReceiptStatementSubject,
    control: ALReceiptStatementSubject
): boolean {
    const priorPayload = prior.control.payload;
    const payload = control.control.payload;
    return priorPayload.logicalRecipientPeerId === payload.logicalRecipientPeerId &&
        (isSameProofStatement(prior, control) || (isALOwnWord(priorPayload) && isALOwnWord(payload)));
}

/**
 * A stored ACK that confirms `control`'s recipient (`isALRecipientConfirmationAck`) and is the same statement as
 * `control`.
 */
export function hasALConfirmedStatement(
    acks: readonly ALReceiptStatementSubject[],
    control: ALReceiptStatementSubject
): boolean {
    return acks.some((prior) => isConfirmation(prior) && isALSameReceiptStatement(prior, control));
}

/**
 * The row records `control`'s recipient outside by the same statement: the recipient is on
 * `pending.outsideAudiencePeerIds`, and a stored control that records it outside (an outside-audience NACK of the
 * history, or an ACK that confirms nobody) is the same statement as `control`. Once the history holds no such control,
 * nothing here records the recipient outside: the relay forwards `control` and the origin judges it.
 */
export function hasALOutsideStatement(
    pending: ALPendingAckSnapshot,
    history: ALReceiptStatementHistory,
    control: ALReceiptStatementSubject
): boolean {
    const recipientPeerId = control.control.payload.logicalRecipientPeerId;
    if (!pending.outsideAudiencePeerIds.includes(recipientPeerId)) {
        return false;
    }
    const recorders = [
        ...history.nacks,
        ...history.acks.filter((prior) => !isConfirmation(prior))
    ].filter((prior) => prior.control.payload.logicalRecipientPeerId === recipientPeerId);
    return recorders.some((prior) => isALSameReceiptStatement(prior, control));
}

/**
 * The first control of each distinct statement, in order; buckets by recipient before it compares. The relation is not
 * transitive, so a control is kept unless an earlier control of its bucket is the same statement, never keyed.
 */
export function toFirstOfEachALReceiptStatement(controls: readonly ALReceiptControl[]): readonly ALReceiptControl[] {
    const subjects = controls.map(toSubject);
    const firsts = new Set(
        [...toRecipientBuckets(controls).values()].flatMap((bucket) =>
            bucket.filter((index, position) =>
                !bucket.slice(0, position).some((prior) => isALSameReceiptStatement(subjects[prior], subjects[index]))
            )
        )
    );
    return controls.filter((_control, index) => firsts.has(index));
}

function toSubject(control: ALReceiptControl): ALReceiptStatementSubject {
    let signedContent: string | undefined;
    return { control, readSignedContent: () => (signedContent ??= toALReceiptProofSigningInput(control)) };
}

/** Each recipient's control indices in input order, the recipients in first-seen order. */
function toRecipientBuckets(controls: readonly ALReceiptControl[]): ReadonlyMap<string, readonly number[]> {
    const buckets = new Map<string, number[]>();
    controls.forEach((control, index) => {
        const recipientPeerId = control.payload.logicalRecipientPeerId;
        const bucket = buckets.get(recipientPeerId);
        if (bucket === undefined) {
            buckets.set(recipientPeerId, [index]);
        }
        else {
            bucket.push(index);
        }
    });
    return buckets;
}

function isConfirmation(subject: ALReceiptStatementSubject): boolean {
    return subject.control.type === 'ack' && isALRecipientConfirmationAck(subject.control.payload);
}

function isSameProofStatement(prior: ALReceiptStatementSubject, control: ALReceiptStatementSubject): boolean {
    const proof = prior.control.payload.proof;
    return isSameSignatureProof(proof, control.control.payload.proof) &&
        (proof === null ||
            (prior.control.type === control.control.type &&
                prior.readSignedContent() === control.readSignedContent()));
}
