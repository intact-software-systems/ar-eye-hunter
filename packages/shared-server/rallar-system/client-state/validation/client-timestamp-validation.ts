import { rejectClientMutation } from './client-mutation-rejection.ts';
import type { ClientValidationValue } from './client-record-validation.ts';

export function requireTimestamp(value: ClientValidationValue, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
        rejectClientMutation(`${label} must be a finite safe nonnegative integer`);
    }
}

export function requireNullableTimestamp(
    value: ClientValidationValue,
    label: string
): asserts value is number | null {
    if (value !== null) {
        requireTimestamp(value, label);
    }
}

export function requireOptionalTimestamp(value: ClientValidationValue, label: string): void {
    if (value !== undefined) {
        requireTimestamp(value, label);
    }
}

export function requirePositiveSafeInteger(
    value: ClientValidationValue,
    label: string
): asserts value is number {
    requireTimestamp(value, label);
    if ((value as number) < 1) {
        rejectClientMutation(`${label} must be at least 1`);
    }
}
