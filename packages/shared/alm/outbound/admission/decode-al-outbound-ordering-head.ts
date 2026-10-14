import { decodeALAdmissionNumber, decodeALAdmissionRecord } from '../../al-admission-value-validation.ts';

export interface ALOutboundOrderingHeadRow {
    readonly seq: number;
}

export function decodeALOutboundOrderingHead(value: unknown): ALOutboundOrderingHeadRow {
    const seq = decodeALAdmissionNumber(decodeALAdmissionRecord(value, ['seq']).seq);
    if (seq < 1) {
        throw new TypeError('Stored outbound ordering head is invalid');
    }
    return { seq };
}
