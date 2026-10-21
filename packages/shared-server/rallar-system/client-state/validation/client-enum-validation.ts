import type { ValidationValue } from '../../protocol/validation-value.ts';
import { rejectClientMutation } from './client-mutation-rejection.ts';

export function requireEnum<T extends string>(
    value: ValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T {
    if (typeof value !== 'string' || !allowed.has(value as T)) {
        rejectClientMutation(`${label} has an invalid value`);
    }
}

export function requireNullableEnum<T extends string>(
    value: ValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T | null {
    if (value !== null) {
        requireEnum(value, allowed, label);
    }
}

export function requireOptionalEnum<T extends string>(
    value: ValidationValue,
    allowed: ReadonlySet<T>,
    label: string
): asserts value is T | undefined {
    if (value !== undefined) {
        requireEnum(value, allowed, label);
    }
}
