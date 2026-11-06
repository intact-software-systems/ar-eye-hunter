import type { PersistedALRecord } from '../../../../al-contracts/al-message-persistence/persisted-al-value-validation.ts';
import {
    decodeALAdmissionArray,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
} from '../../../al-admission-value-validation.ts';

/**
 * The sequences a carrier of the session sent one track to an audience it did not record (a WS leg hands its audience
 * to the server) whose recipients no receipt has named: any recipient may hold one of them. `unreceiptedSeq` is the
 * highest one whose send asked for no logical receipt, which no receipt will ever answer; `pendingReceiptSeqs` are the
 * ones, ascending, whose `admitted` receipt has not landed yet.
 */
export interface ALOutboundRoomSentPositionRow {
    readonly unreceiptedSeq: number;
    readonly pendingReceiptSeqs: readonly number[];
}

/** A commit's move of the room-wide sent position: the floor its read found, written only while the row still holds it. */
export interface ALOutboundRoomSentPositionChange {
    readonly observed: ALOutboundRoomSentPositionRow | undefined;
    readonly value: ALOutboundRoomSentPositionRow;
}

/** How many receipts a track's floor waits on at once; past it, the oldest wait becomes one no receipt answers. */
export const AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS = 64;

const EMPTY_ROOM_SENT_POSITION: ALOutboundRoomSentPositionRow = { unreceiptedSeq: 0, pendingReceiptSeqs: [] };

/**
 * Also reads the two shapes earlier builds wrote: a bare `seq`, the floor of every minting send, as a sequence no
 * receipt answers; and `seq` beside a `resolvedSeq`, as one only while no receipt resolved it.
 */
export function decodeALOutboundRoomSentPositionRow(value: unknown): ALOutboundRoomSentPositionRow {
    const record = decodeALAdmissionRecord(value, [], ['seq', 'resolvedSeq', 'unreceiptedSeq', 'pendingReceiptSeqs']);
    if (record.seq !== undefined) {
        return decodeEarlierALOutboundRoomSentPositionRow(record);
    }
    const pendingReceiptSeqs = decodeALAdmissionArray(record.pendingReceiptSeqs, decodeALAdmissionNumber);
    if (
        pendingReceiptSeqs.length > AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS ||
        pendingReceiptSeqs.some((seq, index) => seq <= (pendingReceiptSeqs[index - 1] ?? 0))
    ) {
        throw new TypeError('Stored outbound pending receipt sequences are invalid');
    }
    return { unreceiptedSeq: decodeALAdmissionNumber(record.unreceiptedSeq), pendingReceiptSeqs };
}

function decodeEarlierALOutboundRoomSentPositionRow(record: PersistedALRecord): ALOutboundRoomSentPositionRow {
    const seq = decodeALAdmissionNumber(record.seq);
    const resolvedSeq = record.resolvedSeq === undefined ? 0 : decodeALAdmissionNumber(record.resolvedSeq);
    if (seq < 1 || record.unreceiptedSeq !== undefined || record.pendingReceiptSeqs !== undefined) {
        throw new TypeError('Stored outbound room sent position is invalid');
    }
    return { unreceiptedSeq: seq > resolvedSeq ? seq : 0, pendingReceiptSeqs: [] };
}

/**
 * The floor after a send that records none of its recipients takes `seq`: a send whose `admitted` receipt will name
 * them waits for it, any other never resolves. A wait past the cap, or one below the unanswered sequence, says nothing
 * that sequence does not, so it is folded into it.
 */
export function computeALOutboundRoomSentPositionMint(
    observed: ALOutboundRoomSentPositionRow | undefined,
    seq: number,
    receipted: boolean
): ALOutboundRoomSentPositionRow {
    const current = observed ?? EMPTY_ROOM_SENT_POSITION;
    if (!receipted) {
        return toFoldedALOutboundRoomSentPosition(Math.max(current.unreceiptedSeq, seq), current.pendingReceiptSeqs);
    }
    const pendingReceiptSeqs = [...current.pendingReceiptSeqs, seq].toSorted((left, right) => left - right);
    const overflow = pendingReceiptSeqs.length - AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS;
    return toFoldedALOutboundRoomSentPosition(
        Math.max(current.unreceiptedSeq, ...pendingReceiptSeqs.slice(0, Math.max(overflow, 0))),
        pendingReceiptSeqs
    );
}

/** The floor once the `admitted` receipt of `seq` named its recipients; undefined when the floor does not wait on it. */
export function computeALOutboundRoomSentPositionReceipt(
    observed: ALOutboundRoomSentPositionRow,
    seq: number
): ALOutboundRoomSentPositionRow | undefined {
    return observed.pendingReceiptSeqs.includes(seq)
        ? {
            unreceiptedSeq: observed.unreceiptedSeq,
            pendingReceiptSeqs: observed.pendingReceiptSeqs.filter((pending) => pending !== seq)
        }
        : undefined;
}

/** The highest sequence any recipient may hold that no receipt has named, `0` for none. */
export function toALOutboundUnknownAudienceSeq(row: ALOutboundRoomSentPositionRow | undefined): number {
    return Math.max(row?.unreceiptedSeq ?? 0, row?.pendingReceiptSeqs.at(-1) ?? 0);
}

function toFoldedALOutboundRoomSentPosition(
    unreceiptedSeq: number,
    pendingReceiptSeqs: readonly number[]
): ALOutboundRoomSentPositionRow {
    return { unreceiptedSeq, pendingReceiptSeqs: pendingReceiptSeqs.filter((seq) => seq > unreceiptedSeq) };
}
