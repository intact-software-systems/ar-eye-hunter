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
export interface ALOutboundRoomSentFloorRow {
    readonly unreceiptedSeq: number;
    readonly pendingReceiptSeqs: readonly number[];
}

/** A commit's move of the room-wide floor: the floor its read found, written only while the row still holds it. */
export interface ALOutboundRoomSentFloorChange {
    readonly observed: ALOutboundRoomSentFloorRow | undefined;
    readonly value: ALOutboundRoomSentFloorRow;
}

/** How many receipts a track's floor waits on at once; past it, the oldest wait becomes one no receipt answers. */
export const AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS = 64;

const EMPTY_ROOM_SENT_FLOOR: ALOutboundRoomSentFloorRow = { unreceiptedSeq: 0, pendingReceiptSeqs: [] };

export function decodeALOutboundRoomSentFloorRow(value: unknown): ALOutboundRoomSentFloorRow {
    const record = decodeALAdmissionRecord(value, ['unreceiptedSeq', 'pendingReceiptSeqs']);
    const pendingReceiptSeqs = decodeALAdmissionArray(record.pendingReceiptSeqs, decodeALAdmissionNumber);
    if (
        pendingReceiptSeqs.length > AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS ||
        pendingReceiptSeqs.some((seq, index) => seq <= (pendingReceiptSeqs[index - 1] ?? 0))
    ) {
        throw new TypeError('Stored outbound pending receipt sequences are invalid');
    }
    return { unreceiptedSeq: decodeALAdmissionNumber(record.unreceiptedSeq), pendingReceiptSeqs };
}

/**
 * The floor after a send that records none of its recipients takes `seq`: a send whose `admitted` receipt will name
 * them waits for it, any other never resolves. A wait past the cap, or one below the unanswered sequence, says nothing
 * that sequence does not, so it is folded into it.
 */
export function computeALOutboundRoomSentFloorMint(
    observed: ALOutboundRoomSentFloorRow | undefined,
    seq: number,
    receipted: boolean
): ALOutboundRoomSentFloorRow {
    const current = observed ?? EMPTY_ROOM_SENT_FLOOR;
    if (!receipted) {
        return toFoldedALOutboundRoomSentFloor(Math.max(current.unreceiptedSeq, seq), current.pendingReceiptSeqs);
    }
    const pendingReceiptSeqs = [...current.pendingReceiptSeqs, seq].toSorted((left, right) => left - right);
    const overflow = pendingReceiptSeqs.length - AL_OUTBOUND_MAX_PENDING_RECEIPT_SEQS;
    return toFoldedALOutboundRoomSentFloor(
        Math.max(current.unreceiptedSeq, ...pendingReceiptSeqs.slice(0, Math.max(overflow, 0))),
        pendingReceiptSeqs
    );
}

/** The floor once the `admitted` receipt of `seq` named its recipients; undefined when the floor does not wait on it. */
export function computeALOutboundRoomSentFloorReceipt(
    observed: ALOutboundRoomSentFloorRow,
    seq: number
): ALOutboundRoomSentFloorRow | undefined {
    return observed.pendingReceiptSeqs.includes(seq)
        ? {
            unreceiptedSeq: observed.unreceiptedSeq,
            pendingReceiptSeqs: observed.pendingReceiptSeqs.filter((pending) => pending !== seq)
        }
        : undefined;
}

/** The highest sequence any recipient may hold that no receipt has named, `0` for none. */
export function toALOutboundUnknownAudienceSeq(row: ALOutboundRoomSentFloorRow | undefined): number {
    return Math.max(row?.unreceiptedSeq ?? 0, row?.pendingReceiptSeqs.at(-1) ?? 0);
}

function toFoldedALOutboundRoomSentFloor(
    unreceiptedSeq: number,
    pendingReceiptSeqs: readonly number[]
): ALOutboundRoomSentFloorRow {
    return { unreceiptedSeq, pendingReceiptSeqs: pendingReceiptSeqs.filter((seq) => seq > unreceiptedSeq) };
}
