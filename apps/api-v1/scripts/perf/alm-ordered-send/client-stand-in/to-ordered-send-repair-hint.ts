import type { ALNackPayload, ALPeerRepairControlMessage, ALRepairPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundControlRepairHint } from '@shared/alm/outbound/control/to-al-outbound-control-repair-hint.ts';

import type { OrderedSendSentMessage } from './compute-ordered-send-repair-reoffers.ts';

export interface ToOrderedSendRepairHintInput {
    /** The NACK or the repair request a session's socket read. */
    readonly control: ALPeerRepairControlMessage;
    readonly readerPeerId: string;
    /** Every send the reader has offered. */
    readonly sentMessages: readonly OrderedSendSentMessage[];
}

/**
 * The repair hint a control raises at the session that read it, built by the product's own
 * `toALOutboundControlRepairHint`, or nothing when the product's WS client would raise none. Of what that client
 * checks before it admits a control (`validateALOutboundControlAdmission`, `toRepairHintEffect`), this keeps: a NACK
 * raises a hint only for a gap; the control is addressed to its reader, and a NACK names it as the origin; it is about
 * a send the reader offered; and its ordering hints match that send, as `hasValidOrderingHints` puts it. It leaves
 * out who the requester is, since only the server writes to a session's socket, and whether the control or its
 * message is a repeat or ended, which the attempt identities and the repair budget of the re-offers decide here.
 */
export function toOrderedSendRepairHint(input: ToOrderedSendRepairHintInput): ALOutboundRepairHint | undefined {
    const { control, readerPeerId } = input;
    const { payload } = control;
    const namedSend = input.sentMessages.find((sent) => sent.msgId === payload.msgId);
    if (
        namedSend === undefined || payload.toPeerId !== readerPeerId ||
        (control.type === 'nack' && (payload.reason !== 'gap' || control.payload.originPeerId !== readerPeerId)) ||
        !hasOrderingHintsOfSend(payload, namedSend)
    ) {
        return undefined;
    }
    return toALOutboundControlRepairHint(control);
}

/** A control that states a track, an expected sequence or a range states them of the track below the send it names. */
function hasOrderingHintsOfSend(payload: ALNackPayload | ALRepairPayload, namedSend: OrderedSendSentMessage): boolean {
    const missingRanges = payload.missingRanges ?? [];
    const { expectedSeq } = payload;
    if (payload.orderingKey === undefined && expectedSeq === undefined && missingRanges.length === 0) {
        return true;
    }
    return namedSend.trackKey !== undefined && payload.orderingKey === namedSend.trackKey &&
        (expectedSeq === undefined || expectedSeq <= namedSend.seq) &&
        missingRanges.every((range) =>
            range.to < namedSend.seq && (expectedSeq === undefined || range.from >= expectedSeq)
        );
}
