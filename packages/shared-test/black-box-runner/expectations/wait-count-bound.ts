import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

/**
 * The cardinality a `count` wait accepts: an exact non-negative integer, or a
 * `{min,max}` range with either end optional. Shared by the WS and RTC waits so
 * one vocabulary decides both.
 */
export interface WaitCountBound {
    readonly min: number;
    readonly max: number;
}

const RANGE_KEYS = ['min', 'max'];

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * Returns `undefined` for anything that does not name a bound, which the waits
 * report as a failed expectation. Nothing is coerced and nothing is defaulted
 * into existence: a `count` that named no recognised key would otherwise become
 * an unbounded range, and an unbounded range is a cardinality assertion no
 * observed count can fail.
 */
export function toWaitCountBound(count: ApiJsonValue | undefined): WaitCountBound | undefined {
    if (isNonNegativeInteger(count)) {
        return { min: count, max: count };
    }

    if (!count || typeof count !== 'object' || Array.isArray(count)) {
        return undefined;
    }

    const range = count as { min?: ApiJsonValue; max?: ApiJsonValue; };
    if (!RANGE_KEYS.some((key) => range[key as 'min' | 'max'] !== undefined)) {
        return undefined;
    }

    const min = range.min === undefined ? 0 : range.min;
    const max = range.max === undefined ? Number.POSITIVE_INFINITY : range.max;
    const isBounded = isNonNegativeInteger(min) &&
        (max === Number.POSITIVE_INFINITY || isNonNegativeInteger(max));

    return isBounded && (min as number) <= (max as number)
        ? { min: min as number, max: max as number }
        : undefined;
}
