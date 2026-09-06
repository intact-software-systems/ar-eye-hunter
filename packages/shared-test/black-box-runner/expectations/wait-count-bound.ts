import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';

/**
 * The cardinality a `count` wait accepts: an exact non-negative integer, or a
 * `{min,max}` range with either end optional. Shared by the WS and RTC waits so
 * one vocabulary decides both.
 */
export interface WaitCountBound {
    readonly min: number;
    readonly max: number;
}

function isNonNegativeInteger(value: ApiJsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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

    const range = count as ApiJsonObject;
    if (range.min === undefined && range.max === undefined) {
        return undefined;
    }

    const min = range.min === undefined ? 0 : range.min;
    const max = range.max === undefined ? Number.POSITIVE_INFINITY : range.max;
    if (
        !isNonNegativeInteger(min) ||
        !(max === Number.POSITIVE_INFINITY || isNonNegativeInteger(max)) || min > max
    ) {
        return undefined;
    }
    return { min, max };
}
