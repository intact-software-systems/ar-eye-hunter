import { decodeALAdmissionNumber, decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';

export interface ALOutboundSentPositionRow {
    readonly seq: number;
}

export function decodeALOutboundSentPosition(value: unknown): ALOutboundSentPositionRow {
    const seq = decodeALAdmissionNumber(decodeALAdmissionRecord(value, ['seq']).seq);
    if (seq < 1) {
        throw new TypeError('Stored outbound sent position is invalid');
    }
    return { seq };
}
