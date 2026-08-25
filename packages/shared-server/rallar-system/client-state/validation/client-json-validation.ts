import { rejectClientMutation } from './client-mutation-rejection.ts';
import { decodeClientValidationRecord, type ClientValidationValue } from './client-record-validation.ts';

export function requireJsonRecord(value: ClientValidationValue, label: string): void {
    decodeClientValidationRecord(value, label);
    requireJsonValue(value, label);
}

export function requireNullableJsonRecord(value: ClientValidationValue, label: string): void {
    if (value !== null) {
        requireJsonRecord(value, label);
    }
}

function requireJsonValue(value: ClientValidationValue, label: string): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            rejectClientMutation(`${label} contains a non-JSON number`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => requireJsonValue(item, `${label}[${index}]`));
        return;
    }
    const record = decodeClientValidationRecord(value, label);
    for (const [key, item] of Object.entries(record)) {
        requireJsonValue(item, `${label}.${key}`);
    }
}
