import { rejectClientMutation } from './client-mutation-rejection.ts';

export type ClientValidationValue =
    | null
    | boolean
    | number
    | string
    | readonly ClientValidationValue[]
    | ClientValidationRecord
    | undefined;

export interface ClientValidationRecord {
    readonly [key: string]: ClientValidationValue;
}

export function decodeClientValidationRecord(
    value: unknown,
    label: string
): ClientValidationRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        rejectClientMutation(`${label} must be a plain object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        rejectClientMutation(`${label} must be a plain object`);
    }
    return value as ClientValidationRecord;
}

interface RequireAllowedKeysInput {
    readonly value: ClientValidationRecord;
    readonly required: readonly string[];
    readonly allowed: readonly string[];
    readonly label: string;
}

export function requireExactKeys(
    value: ClientValidationRecord,
    keys: readonly string[],
    label: string
): void {
    const expected = new Set(keys);
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            rejectClientMutation(`${label}.${key} is required`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) {
            rejectClientMutation(`${label}.${key} is not allowed`);
        }
    }
}

export function requireAllowedKeys({
    value,
    required,
    allowed,
    label
}: RequireAllowedKeysInput): void {
    const expected = new Set(allowed);
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            rejectClientMutation(`${label}.${key} is required`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) {
            rejectClientMutation(`${label}.${key} is not allowed`);
        }
    }
}
