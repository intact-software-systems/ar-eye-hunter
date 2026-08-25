import { rejectClientMutation } from './client-mutation-rejection.ts';
import type { ClientValidationValue } from './client-record-validation.ts';

export function requireEnum<T extends string>(
    value: ClientValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T {
    if (typeof value !== 'string' || !allowed.has(value as T)) {
        rejectClientMutation(`${label} has an invalid value`);
    }
}

export function requireNullableEnum<T extends string>(
    value: ClientValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T | null {
    if (value !== null) {
        requireEnum(value, allowed, label);
    }
}

export function requireOptionalEnum<T extends string>(
    value: ClientValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T | undefined {
    if (value !== undefined) {
        requireEnum(value, allowed, label);
    }
}
