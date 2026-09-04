import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue
} from './al-admission-backend.ts';
import { decodeALAdmissionValue } from './al-admission-decoder.ts';
import {
    decodeALAdmissionRecord,
    decodeALAdmissionString
} from './al-admission-value-validation.ts';

export interface IndexedDbAdmissionStoredRow {
    readonly key: string;
    readonly value: ALAdmissionStoredValue['value'];
    readonly expireAtTimestamp: number;
    readonly writeToken: string;
}

export function decodeIndexedDbAdmissionStoredRow(
    value: IDBRequest['result'],
    key: string
): IndexedDbAdmissionStoredRow {
    return decodeALAdmissionValue(value, key, (candidate) => {
        const record = decodeALAdmissionRecord(
            candidate,
            ['key', 'value', 'expireAtTimestamp', 'writeToken']
        );
        const canonical = decodeALAdmissionStoredValue({
            key: record.key,
            value: record.value,
            expireAtTimestamp: record.expireAtTimestamp
        }, key);
        return {
            key: canonical.key,
            value: record.value,
            expireAtTimestamp: canonical.expireAtTimestamp,
            writeToken: decodeALAdmissionString(record.writeToken)
        };
    });
}

export function toALAdmissionStoredValue(
    stored: IndexedDbAdmissionStoredRow
): ALAdmissionStoredValue {
    return {
        key: stored.key,
        value: stored.value,
        expireAtTimestamp: stored.expireAtTimestamp
    };
}
