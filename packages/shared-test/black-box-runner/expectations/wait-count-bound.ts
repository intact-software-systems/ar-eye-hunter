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

export function toWaitCountBound(count: ApiJsonValue | undefined): WaitCountBound | undefined {
    if (Number.isInteger(count) && (count as number) >= 0) {
        return { min: count as number, max: count as number };
    }

    if (!count || typeof count !== 'object') {
        return undefined;
    }

    const range = count as { min?: number; max?: number; };
    const min = range.min === undefined ? 0 : Number(range.min);
    const max = range.max === undefined ? Number.POSITIVE_INFINITY : Number(range.max);
    const isBounded = Number.isInteger(min) && min >= 0 &&
        (max === Number.POSITIVE_INFINITY || Number.isInteger(max));

    return isBounded && min <= max ? { min, max } : undefined;
}
