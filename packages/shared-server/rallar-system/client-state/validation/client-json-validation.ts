import type { ValidationValue } from '../../protocol/validation-value.ts';
import { rejectClientMutation } from './client-mutation-rejection.ts';
import { decodeClientValidationRecord } from './client-record-validation.ts';

export function requireJsonRecord(value: ValidationValue, label: string): void {
    decodeClientValidationRecord(value, label);
    requireJsonValue(value, label);
}

export function requireNullableJsonRecord(value: ValidationValue, label: string): void {
    if (value !== null) {
        requireJsonRecord(value, label);
    }
}

function requireJsonValue(value: ValidationValue, label: string): void {
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
