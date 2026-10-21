import type { ValidationValue } from '../../protocol/validation-value.ts';
import { rejectClientMutation } from './client-mutation-rejection.ts';

export function requireNonEmptyString(
    value: ValidationValue,
    label: string
): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        rejectClientMutation(`${label} must be a non-empty string`);
    }
}

export function requireString(value: ValidationValue, label: string): asserts value is string {
    if (typeof value !== 'string') {
        rejectClientMutation(`${label} must be a string`);
    }
}

export function requireNullableString(value: ValidationValue, label: string): void {
    if (value !== null) {
        requireString(value, label);
    }
}

export function requireNullableNonEmptyString(value: ValidationValue, label: string): void {
    if (value !== null) {
        requireNonEmptyString(value, label);
    }
}

export function requireOptionalString(value: ValidationValue, label: string): void {
    if (value !== undefined) {
        requireString(value, label);
    }
}

export function requireOptionalNonEmptyString(value: ValidationValue, label: string): void {
    if (value !== undefined) {
        requireNonEmptyString(value, label);
    }
}

export function requireStringArray(
    value: ValidationValue,
    label: string
): asserts value is readonly string[] {
    if (!Array.isArray(value)) {
        rejectClientMutation(`${label} must be an array`);
    }
    value.forEach((item, index) => requireNonEmptyString(item, `${label}[${index}]`));
}

export function requireNullableStringArray(value: ValidationValue, label: string): void {
    if (value !== null) {
        requireStringArray(value, label);
    }
}

export function requireSha256(value: ValidationValue, label: string): void {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        rejectClientMutation(`${label} must be a canonical SHA-256 digest`);
    }
}
