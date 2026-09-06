import { describe, expect, it } from 'vitest';

import { toWaitCountBound } from '../../shared-test/black-box-runner/expectations/wait-count-bound.ts';

describe('toWaitCountBound', () => {
    it('accepts an exact non-negative integer', () => {
        expect(toWaitCountBound(0)).toEqual({ min: 0, max: 0 });
        expect(toWaitCountBound(3)).toEqual({ min: 3, max: 3 });
    });

    it('accepts a range with either end omitted', () => {
        expect(toWaitCountBound({ min: 1, max: 3 })).toEqual({ min: 1, max: 3 });
        expect(toWaitCountBound({ min: 2 })).toEqual({ min: 2, max: Number.POSITIVE_INFINITY });
        expect(toWaitCountBound({ max: 2 })).toEqual({ min: 0, max: 2 });
    });

    // A count object naming no bound would otherwise become {0, INFINITY},
    // which no observed count can fail — a wait that asserts nothing while
    // reading as though it asserts cardinality.
    it('rejects an object that names no bound', () => {
        expect(toWaitCountBound({})).toBeUndefined();
        expect(toWaitCountBound({ exactly: 1 })).toBeUndefined();
        expect(toWaitCountBound({ minimum: 1 })).toBeUndefined();
    });

    it('rejects an array, which is not a range', () => {
        expect(toWaitCountBound([1, 3])).toBeUndefined();
        expect(toWaitCountBound([])).toBeUndefined();
    });

    // The exact form required a real number while the range form coerced, so
    // the same value was accepted in one shape and rejected in the other.
    it('requires real numbers in both shapes rather than coercing one', () => {
        expect(toWaitCountBound('2')).toBeUndefined();
        expect(toWaitCountBound({ min: '2' })).toBeUndefined();
        expect(toWaitCountBound({ min: 1, max: '3' })).toBeUndefined();
    });

    it('rejects negative, fractional and inverted bounds', () => {
        expect(toWaitCountBound(-1)).toBeUndefined();
        expect(toWaitCountBound(1.5)).toBeUndefined();
        expect(toWaitCountBound({ min: -1 })).toBeUndefined();
        expect(toWaitCountBound({ min: 3, max: 1 })).toBeUndefined();
    });

    it('rejects a missing count', () => {
        expect(toWaitCountBound(undefined)).toBeUndefined();
        expect(toWaitCountBound(null)).toBeUndefined();
    });
});
