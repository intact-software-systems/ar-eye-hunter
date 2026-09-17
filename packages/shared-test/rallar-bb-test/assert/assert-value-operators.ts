import { CompareJson } from '../../json-compare/json-compare.ts';

import type { RallarBlackBoxTestAssertOperator } from '../rallar-black-box-test-contracts.ts';
import {
    hasContainedText,
    isSameJsonValue,
    type PayloadPathLookup
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
    'matchesShapeComplete'
] as const;

type PresentValueAssertOperator = Exclude<RallarBlackBoxTestAssertOperator, 'exists' | 'notEquals'>;

/** A recipe expectation and the evidence it is compared with; both are opaque JSON. */
interface AssertComparison {
    readonly actual: unknown;
    readonly expected: unknown;
}

export function isRallarBlackBoxAssertOperator(
    value: unknown
): value is RallarBlackBoxTestAssertOperator {
    return typeof value === 'string' &&
        RALLAR_BLACK_BOX_ASSERT_OPERATORS.some((operator) => operator === value);
}

export function isAssertOperatorSatisfied(
    source: PayloadPathLookup,
    operator: RallarBlackBoxTestAssertOperator,
    expected: unknown
): boolean {
    switch (operator) {
        case 'exists':
            return expected === undefined ? source.exists : source.exists === Boolean(expected);
        case 'notEquals':
            return !source.exists || !isSameJsonValue(source.value, expected);
        default:
            return source.exists && isPresentValueOperatorSatisfied(operator, { actual: source.value, expected });
    }
}

/** gt, lt, between, length and matches coerce like the runner comparators; gte and lte stay strictly numeric. */
function isPresentValueOperatorSatisfied(
    operator: PresentValueAssertOperator,
    comparison: AssertComparison
): boolean {
    const { actual, expected } = comparison;
    switch (operator) {
        case 'equals':
            return isSameJsonValue(actual, expected);
        case 'contains':
            return isContainsSatisfied(comparison);
        case 'gte':
            return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
        case 'lte':
            return typeof actual === 'number' && typeof expected === 'number' && actual <= expected;
        case 'gt':
            return isBoundSatisfied(decodeCoercedNumber(actual), decodeCoercedNumber(expected), 'above');
        case 'lt':
            return isBoundSatisfied(decodeCoercedNumber(actual), decodeCoercedNumber(expected), 'below');
        case 'between':
            return isBetweenSatisfied(decodeCoercedNumber(actual), decodeBetweenBounds(expected));
        case 'length':
            return decodeCollectionLength(actual) === Number(expected);
        case 'matches':
            return typeof actual === 'string' && isPatternMatch(actual, String(expected));
        case 'matchesShape':
            return CompareJson.compatible(expected, actual).isEqual;
        case 'matchesShapeComplete':
            return CompareJson.compatibleComplete(expected, actual).isEqual;
    }
}

function isContainsSatisfied(comparison: AssertComparison): boolean {
    const { actual, expected } = comparison;
    if (Array.isArray(actual)) {
        return actual.some((entry) => isSameJsonValue(entry, expected));
    }
    if (typeof actual === 'string') {
        return actual.includes(String(expected));
    }
    if (actual !== null && typeof actual === 'object') {
        return typeof expected === 'string'
            ? hasContainedText(actual, expected)
            : Object.values(actual).some((entry) => isSameJsonValue(entry, expected));
    }
    return hasContainedText(actual, String(expected));
}

function isBoundSatisfied(
    actual: number | undefined,
    bound: number | undefined,
    direction: 'above' | 'below'
): boolean {
    if (actual === undefined || bound === undefined) {
        return false;
    }
    return direction === 'above' ? actual > bound : actual < bound;
}

function isBetweenSatisfied(
    actual: number | undefined,
    bounds: readonly [number, number] | undefined
): boolean {
    return actual !== undefined && bounds !== undefined && actual >= bounds[0] && actual <= bounds[1];
}

function isPatternMatch(text: string, pattern: string): boolean {
    try {
        return new RegExp(pattern).test(text);
    }
    catch (_error) {
        return false;
    }
}

/** Absent when Number() does not coerce the value to a finite number. */
function decodeCoercedNumber(value: unknown): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const coerced = Number(value);
    return Number.isFinite(coerced) ? coerced : undefined;
}

/** Absent unless the value is a pair whose members coerce to finite numbers. */
function decodeBetweenBounds(value: unknown): readonly [number, number] | undefined {
    if (!Array.isArray(value) || value.length !== 2) {
        return undefined;
    }
    const lower = Number(value[0]);
    const upper = Number(value[1]);
    return Number.isFinite(lower) && Number.isFinite(upper) ? [lower, upper] : undefined;
}

/** Absent unless the value is an array or text. */
function decodeCollectionLength(value: unknown): number | undefined {
    return Array.isArray(value) || typeof value === 'string' ? value.length : undefined;
}
