import type { GroupRef } from '@shared/api/group-types.ts';

import type { JsonWireValue } from '../protocol/json-wire-identity.ts';

export type GroupStateValidationValue =
    | null
    | boolean
    | number
    | string
    | readonly GroupStateValidationValue[]
    | GroupStateValidationRecord
    | undefined;

export interface GroupStateValidationRecord {
    readonly [key: string]: GroupStateValidationValue;
}

export function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
    if (unexpected) {
        throw new TypeError(`${label} has unexpected key: ${unexpected}`);
    }
}

export function assertRequiredKeys(
    value: object,
    required: readonly string[],
    label: string
): void {
    const missing = required.find((key) => !Object.hasOwn(value, key));
    if (missing) {
        throw new TypeError(`${label} is missing mandatory key: ${missing}`);
    }
}

export function requireOneOf<Allowed extends string>(
    value: unknown,
    allowed: readonly Allowed[],
    label: string
): asserts value is Allowed {
    if (typeof value !== 'string' || !allowed.some((entry) => entry === value)) {
        throw new TypeError(`${label} is invalid`);
    }
}

export function requireRecord(value: unknown, label: string): GroupStateValidationRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value as GroupStateValidationRecord;
}

export function requireNonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
}

export function nullableNonEmptyString(value: unknown, label: string): asserts value is string | null {
    if (value !== null) {
        requireNonEmptyString(value, label);
    }
}

export function requireNonNegativeSafeInteger(
    value: unknown,
    label: string
): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
}

export function requirePositiveSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
}

export function nullablePositiveSafeInteger(
    value: unknown,
    label: string
): asserts value is number | null {
    if (value !== null) {
        requirePositiveSafeInteger(value, label);
    }
}

export function requireJsonSafe(value: unknown, label: string): asserts value is JsonWireValue {
    requireJsonSafeValue(value, label, new Set<object>());
}

export function validateGroupRef(value: unknown): asserts value is GroupRef {
    const ref = requireRecord(value, 'Group mutation aggregateRef');
    assertExactKeys(ref, ['applicationId', 'workspaceId', 'groupId'], 'Group mutation aggregateRef');
    requireNonEmptyString(ref.applicationId, 'Group applicationId');
    requireNonEmptyString(ref.workspaceId, 'Group workspaceId');
    requireNonEmptyString(ref.groupId, 'Group groupId');
}

function requireJsonSafeValue(
    value: unknown,
    label: string,
    activeObjects: Set<object>
): asserts value is JsonWireValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) {
            throw new TypeError(`${label} must contain only JSON-safe numbers`);
        }
        return;
    }
    if (typeof value !== 'object') {
        throw new TypeError(`${label} must be JSON-safe`);
    }
    if (activeObjects.has(value)) {
        throw new TypeError(`${label} must not be cyclic`);
    }
    activeObjects.add(value);
    requireJsonSafeEntries(value, label, activeObjects);
    activeObjects.delete(value);
}

function requireJsonSafeEntries(value: object, label: string, activeObjects: Set<object>): void {
    if (Array.isArray(value)) {
        for (const entry of value) {
            requireJsonSafeValue(entry, label, activeObjects);
        }
        return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`${label} must use plain objects`);
    }
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) {
            throw new TypeError(`${label}.${key} must be present`);
        }
        requireJsonSafeValue(entry, label, activeObjects);
    }
}
