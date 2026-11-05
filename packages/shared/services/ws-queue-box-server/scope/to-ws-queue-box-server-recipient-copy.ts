import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALOrderingTrackKey } from '../../../al-contracts/al-runtime.ts';
import {
    computeALOrderingPriorSeqRecord
} from '../../../alm/outbound/admission/compute-al-ordering-prior-seq-record.ts';
import { Either } from '../../../resilience/Either.ts';

/** Why the server sends one recipient nothing: a later row of the track already moved it past this sequence. */
export interface WsQueueBoxServerCopySkip {
    readonly kind: 'below-position';
}

export interface ToWsQueueBoxServerRecipientCopyInput {
    readonly message: ALMessage;
    readonly recipientPeerId: string;
    /** Each recorded recipient's position as the row's first dequeue read it; `null` when no dequeue recorded one. */
    readonly sentPositions: Readonly<Record<string, number>> | null;
}

/**
 * The copy one recipient receives: never the origin's proof, since every server copy is the server's word (D519). On a
 * recorded track it carries the server's own entry for that recipient in place of any record the frame came with; a
 * copy no dequeue recorded (a live-only hand-over) carries no record at all. A recipient whose position already passed
 * the sequence is skipped; one at the sequence is a retry, so it is sent again.
 */
export function toWsQueueBoxServerRecipientCopy(
    input: ToWsQueueBoxServerRecipientCopyInput
): Either<WsQueueBoxServerCopySkip, ALMessage> {
    const { recipientPeerId, sentPositions } = input;
    const { proof: _proof, ...message } = input.message;
    const trackKey = toALOrderingTrackKey(message);
    const seq = message.ordering?.seq;
    if (sentPositions === null || trackKey === undefined || seq === undefined) {
        return Either.ofRight(toWsQueueBoxServerUnrecordedCopy(message));
    }
    const priorSeq = sentPositions[recipientPeerId];
    if (priorSeq !== undefined && priorSeq > seq) {
        return Either.ofLeft({ kind: 'below-position' });
    }
    const priorSeqByRecipient = computeALOrderingPriorSeqRecord({
        trackKey,
        seq,
        priorSeqByRecipient: priorSeq === undefined ? {} : { [recipientPeerId]: priorSeq }
    });
    return Either.ofRight({ ...message, ordering: { ...message.ordering, priorSeqByRecipient } });
}

/** A copy the server recorded nothing for speaks for no entry, so it drops any record the frame came with. */
function toWsQueueBoxServerUnrecordedCopy(message: ALMessage): ALMessage {
    if (message.ordering?.priorSeqByRecipient === undefined) {
        return message;
    }
    const { priorSeqByRecipient: _record, ...ordering } = message.ordering;
    return { ...message, ordering };
}
