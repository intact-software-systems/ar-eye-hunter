import {
    decodeALAdmissionCountRecord,
    decodeALAdmissionNumber,
    decodeALAdmissionRecord
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
 * The recipients' positions a sent row's first recording read, `0` for one never sent the track; an absent field is
 * `null`, as a row written before positions were kept reads.
 */
export function decodeALOutboundSentPositionRecord(value: unknown): Readonly<Record<string, number>> | null {
    return value === undefined || value === null
        ? null
        : decodeALAdmissionCountRecord(value, 'outbound sent positions');
}
