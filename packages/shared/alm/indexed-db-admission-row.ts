import {
    decodeALAdmissionStoredValue,
    type ALAdmissionStoredValue
} from './al-admission-backend.ts';
import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
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

export interface DecodeIndexedDbAdmissionValueInput<V> {
    readonly stored: IndexedDbAdmissionStoredRow;
    readonly key: string;
    readonly decode: ALAdmissionDecoder<V>;
    readonly nowMs: number;
}

/** The row's value plus whether it has expired; every reader decides for itself what expiry means. */
export function decodeIndexedDbAdmissionValue<V>(
    input: DecodeIndexedDbAdmissionValueInput<V>
): readonly [value: V, expired: boolean] {
    const canonical = decodeALAdmissionValue(
        toALAdmissionStoredValue(input.stored),
        input.key,
        decodeALAdmissionStoredValue
    );
    const value = decodeALAdmissionValue(canonical.value, input.key, input.decode);
    return [value, canonical.expireAtTimestamp <= input.nowMs];
}
