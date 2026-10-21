import { arePlainJsonValuesEqual, isPlainJsonValue } from './compare-plain-json.ts';

export function arrayEquals<T>(left: readonly T[], right: readonly T[]): boolean {
    return (
        left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
    );
}

export function jsonEquals(left: unknown, right: unknown): boolean {
    // One object is its own JSON content: a shared decode compares without serializing either side.
    if (left === right && typeof left === 'object' && left !== null) {
        return true;
    }
    if (isPlainJsonValue(left) && isPlainJsonValue(right)) {
        return arePlainJsonValuesEqual(left, right);
    }
    // Content ordering follows conversion so toJSON observes the established projection.
    const leftJson = stableJsonStringify(left);
    const rightJson = stableJsonStringify(right);
    if (leftJson === rightJson) {
        return true;
    }
    if (leftJson === undefined || rightJson === undefined) {
        return false;
    }
    return JSON.stringify(toOrderedJson(JSON.parse(leftJson), 'content')) ===
        JSON.stringify(toOrderedJson(JSON.parse(rightJson), 'content'));
}

export function stableJsonStringify(value: unknown): string {
    return JSON.stringify(toStableJson(value));
}

export function toStableJson(value: unknown): unknown {
    // ALM prepared fingerprints persist this ordering, including collation ties.
    return toOrderedJson(value, 'persisted');
}

export function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}

function toOrderedJson(value: unknown, keyOrder: 'content' | 'persisted'): unknown {
    if (Array.isArray(value)) {
        return value.map((entryValue) => toOrderedJson(entryValue, keyOrder));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => {
                if (keyOrder === 'persisted') {
                    return left.localeCompare(right);
                }
                return left < right ? -1 : left > right ? 1 : 0;
            })
            .map(([key, entryValue]) => [key, toOrderedJson(entryValue, keyOrder)])
    );
}
