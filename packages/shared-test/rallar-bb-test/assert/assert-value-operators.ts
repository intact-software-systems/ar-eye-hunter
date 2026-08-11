import { CompareJson } from '../../json-compare/json-compare.ts';
import type { JsonValue } from '../../json-compare/CompareJson.ts';

import type { RallarBlackBoxTestAssertOperator } from '../types.ts';
import {
    containsValue,
    type PayloadPathLookup,
    sameJsonValue,
} from '../wait/wait-event-match.ts';

export const RALLAR_BLACK_BOX_ASSERT_OPERATORS = [
    'equals',
    'notEquals',
    'contains',
    'exists',
    'gte',
    'lte',
    'gt',
    'lt',
    'between',
    'length',
    'matches',
    'matchesShape',
    'matchesShapeComplete',
] as const;

export function isRallarBlackBoxAssertOperator(
    value: unknown,
): value is RallarBlackBoxTestAssertOperator {
    return typeof value === 'string' &&
        RALLAR_BLACK_BOX_ASSERT_OPERATORS.includes(value as RallarBlackBoxTestAssertOperator);
}

export function assertValueMatches(
    source: PayloadPathLookup,
    operator: RallarBlackBoxTestAssertOperator,
    expected: unknown,
): boolean {
    switch (operator) {
        case 'equals':
            return source.exists && sameJsonValue(source.value, expected);
        case 'notEquals':
            return !source.exists || !sameJsonValue(source.value, expected);
        case 'contains':
            return source.exists && containsAssertValue(source.value, expected);
        case 'exists':
            return expected === undefined
                ? source.exists
                : source.exists === Boolean(expected);
        case 'gte':
            return source.exists &&
                typeof source.value === 'number' &&
                typeof expected === 'number' &&
                source.value >= expected;
        case 'lte':
            return source.exists &&
                typeof source.value === 'number' &&
                typeof expected === 'number' &&
                source.value <= expected;
        case 'gt':
            return source.exists &&
                boundedNumberMatches(source.value, expected, (actual, bound) => actual > bound);
        case 'lt':
            return source.exists &&
                boundedNumberMatches(source.value, expected, (actual, bound) => actual < bound);
        case 'between':
            return source.exists && betweenMatches(source.value, expected);
        case 'length':
            return source.exists && lengthMatches(source.value, expected);
        case 'matches':
            return source.exists && regexMatches(source.value, expected);
        case 'matchesShape':
            return source.exists &&
                CompareJson.compatible(expected as JsonValue, source.value as JsonValue).isEqual;
        case 'matchesShapeComplete':
            return source.exists &&
                CompareJson.compatibleComplete(expected as JsonValue, source.value as JsonValue).isEqual;
    }
}

// Runner comparator parity: gt/lt/between/length/matches coerce with Number()
// and require finite bounds, unlike the historical strictly-numeric gte/lte.
function boundedNumberMatches(
    value: unknown,
    bound: unknown,
    satisfies: (actual: number, bound: number) => boolean,
): boolean {
    const actualNumber = Number(value);
    const boundNumber = Number(bound);
    return Number.isFinite(actualNumber) &&
        Number.isFinite(boundNumber) &&
        satisfies(actualNumber, boundNumber);
}

function betweenMatches(value: unknown, expected: unknown): boolean {
    const bounds = Array.isArray(expected) ? expected.map(Number) : [];
    const actualNumber = Number(value);
    if (bounds.length !== 2 || bounds.some(bound => !Number.isFinite(bound))) {
        return false;
    }
    return Number.isFinite(actualNumber) && actualNumber >= bounds[0] && actualNumber <= bounds[1];
}

function lengthMatches(value: unknown, expected: unknown): boolean {
    const expectedLength = Number(expected);
    const actualLength = Array.isArray(value) || typeof value === 'string'
        ? value.length
        : undefined;
    return actualLength !== undefined && actualLength === expectedLength;
}

function regexMatches(value: unknown, expected: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        return new RegExp(String(expected)).test(value);
    } catch (_error) {
        return false;
    }
}

function containsAssertValue(value: unknown, expected: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(entry => sameJsonValue(entry, expected));
    }

    if (typeof value === 'string') {
        return value.includes(String(expected));
    }

    if (value && typeof value === 'object') {
        if (typeof expected === 'string') {
            return containsValue(value, expected);
        }
        return Object.values(value as Record<string, unknown>)
            .some(entry => sameJsonValue(entry, expected));
    }

    return containsValue(value, String(expected));
}
