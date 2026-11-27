import type { ALNackPayload, ALPeerRepairControlMessage, ALRepairPayload } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRepairHint } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundControlRepairHint } from '@shared/alm/outbound/control/to-al-outbound-control-repair-hint.ts';

import { isOrderedSendExpired, type OrderedSendSentMessage } from './compute-ordered-send-repair-reoffers.ts';

export interface ToOrderedSendRepairHintInput {
    /** The NACK or the repair request a session's socket read. */
    readonly control: ALPeerRepairControlMessage;
    readonly readerPeerId: string;
    /** Every send the reader has offered. */
    readonly sentMessages: readonly OrderedSendSentMessage[];
    /** The instant the control was read at, on the clock of the sends' lifetimes. */
    readonly nowMs: number;
}

/**
 * What a control raises at the session that read it: the product's repair hint; `none`, where the product's WS client
 * would refuse the control or raise nothing for it; or `named-send-expired`, where it would raise nothing because the
 * lifetime of the send the control names is over.
 */
export type OrderedSendRepairHint =
    | { readonly kind: 'raised'; readonly hint: ALOutboundRepairHint; }
    | { readonly kind: 'none' | 'named-send-expired'; };

/**
 * The repair hint a control raises at the session that read it, built by the product's own
 * `toALOutboundControlRepairHint`, or why the product's WS client would raise none. Of what that client checks before
 * it admits a control (`validateALOutboundControlAdmission`, `toRepairHintEffect`), this keeps: a NACK raises a hint
 * only for a gap; the control is addressed to its reader, and a NACK names it as the origin; it is about a send the
 * reader offered; its ordering hints match that send, as `hasValidOrderingHints` puts it; and the send it names has
 * not expired (`toRepairHintEffect`: `sent.reference.expiresAtMs <= nowMs` raises none). A control that names a send
 * its publisher has ended still raises its hint, as the product admits a gap report and a repair request for an ended
 * message (`validateALOutboundEndedMessageControl`): the send it names showed the gap, and each send it asks for
 * finds its own end when the hint is served. It leaves out who the requester is, since only the server writes to a
 * session's socket, and whether the control is a repeat, which the attempt identities of the re-offers decide here.
 */
export function toOrderedSendRepairHint(input: ToOrderedSendRepairHintInput): OrderedSendRepairHint {
    const { control, readerPeerId, nowMs } = input;
    const { payload } = control;
    const namedSend = input.sentMessages.find((sent) => sent.msgId === payload.msgId);
    if (
        namedSend === undefined || payload.toPeerId !== readerPeerId ||
        (control.type === 'nack' && (payload.reason !== 'gap' || control.payload.originPeerId !== readerPeerId)) ||
        !hasOrderingHintsOfSend(payload, namedSend)
    ) {
        return { kind: 'none' };
    }
    return isOrderedSendExpired(namedSend, nowMs)
        ? { kind: 'named-send-expired' }
        : { kind: 'raised', hint: toALOutboundControlRepairHint(control) };
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
