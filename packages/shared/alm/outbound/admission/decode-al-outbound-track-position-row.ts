import { decodeALAdmissionNumber, decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';

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
