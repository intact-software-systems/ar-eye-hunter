import { AL_MESSAGE_RESOURCE_LIMITS } from '../../../al-contracts/al-message-resource-limits.ts';
import {
    decodeALAdmissionNumber,
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from '../../al-admission-value-validation.ts';

/** A sequence one ordering track has reached: its head, or the last one sent to one of its recipients. */
export interface ALOutboundTrackPositionRow {
    readonly seq: number;
}

export function decodeALOutboundTrackPositionRow(value: unknown): ALOutboundTrackPositionRow {
    const seq = decodeALAdmissionNumber(decodeALAdmissionRecord(value, ['seq']).seq);
    if (seq < 1) {
        throw new TypeError('Stored outbound track position is invalid');
    }
    return { seq };
}

/**
 * The last sequence a carrier of the session sent one track to an audience it did not record, and the highest sequence
 * whose recipients a receipt has named since: while `seq` lies above `resolvedSeq`, any recipient may hold `seq`.
 */
export interface ALOutboundRoomSentPositionRow {
    readonly seq: number;
    readonly resolvedSeq: number;
}

/** A row an older build wrote holds no `resolvedSeq`: no receipt resolved it, so it reads as `0`. */
export function decodeALOutboundRoomSentPositionRow(value: unknown): ALOutboundRoomSentPositionRow {
    const record = decodeALAdmissionRecord(value, ['seq'], ['resolvedSeq']);
    const seq = decodeALAdmissionNumber(record.seq);
    if (seq < 1) {
        throw new TypeError('Stored outbound room sent position is invalid');
    }
    return { seq, resolvedSeq: record.resolvedSeq === undefined ? 0 : decodeALAdmissionNumber(record.resolvedSeq) };
}

/**
 * The recipients' positions a sent row's first recording read, `0` for one never sent the track; an absent field is
 * `null`, as a row written before positions were kept reads.
 */
export function decodeALOutboundSentPositionRecord(value: unknown): Readonly<Record<string, number>> | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new TypeError('Stored outbound sent positions must be a plain record');
    }
    const entries = Object.entries(value);
    if (entries.length > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) {
        throw new TypeError('Stored outbound sent positions exceed the audience limit');
    }
    return Object.fromEntries(
        entries.map((
            [recipientPeerId, seq]
        ) => [decodeALAdmissionString(recipientPeerId), decodeALAdmissionNumber(seq)])
    );
}
