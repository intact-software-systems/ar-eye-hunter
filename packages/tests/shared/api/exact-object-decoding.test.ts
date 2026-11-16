import { describe, expect, it } from 'vitest';

import {
    decodePlainRecord,
    getOwnCount,
    getOwnField,
    getOwnNumber,
    hasExactKeys
} from '@shared/api/exact-object-decoding.ts';

describe('getOwnNumber', () => {
    it('reads an own number along a path', () => {
        expect(getOwnNumber({ a: { b: 3 } }, ['a', 'b'], Number.NaN)).toBe(3);
    });

    it('reads absent for a field missing anywhere on the path or holding undefined', () => {
        expect(getOwnNumber({}, ['a'], 7)).toBe(7);
        expect(getOwnNumber({ a: {} }, ['a', 'b'], 7)).toBe(7);
        expect(getOwnNumber({ a: undefined }, ['a', 'b'], 7)).toBe(7);
    });

    it('reads NaN for a present non-number or a parent that is not a plain object', () => {
        expect(getOwnNumber({ a: '3' }, ['a'], 7)).toBeNaN();
        expect(getOwnNumber({ a: null }, ['a', 'b'], 7)).toBeNaN();
        expect(getOwnNumber({ a: [1] }, ['a', '0'], 7)).toBeNaN();
    });

    it('does not invoke an accessor and reads it as absent', () => {
        const source = {
            get a(): number {
                throw new Error('accessor invoked');
            }
        };
        expect(getOwnNumber(source, ['a'], 5)).toBe(5);
    });
});

describe('hasExactKeys', () => {
    it('is true for the same key set in any order and false for a missing or extra key', () => {
        expect(hasExactKeys({ a: 1, b: 2 }, ['b', 'a'])).toBe(true);
        expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
        expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
        expect(hasExactKeys({}, [])).toBe(true);
    });
});

describe('decodePlainRecord', () => {
    it('accepts a plain object and refuses null, an array, a scalar and a non-plain prototype', () => {
        expect(decodePlainRecord({ a: 1 }).right).toBeDefined();
        expect(decodePlainRecord(null).left).toBeTypeOf('string');
        expect(decodePlainRecord([]).left).toBeTypeOf('string');
        expect(decodePlainRecord('a').left).toBeTypeOf('string');
        expect(decodePlainRecord(new Date()).left).toBeTypeOf('string');
        expect(decodePlainRecord(Object.create(null)).left).toBeTypeOf('string');
    });
});

describe('getOwnField', () => {
    it('reads an own data property and nothing inherited', () => {
        expect(getOwnField({ a: 'x' }, 'a')).toBe('x');
        expect(getOwnField({}, 'toString')).toBeUndefined();
    });

    it('does not invoke an accessor and reads it as absent', () => {
        const source = {
            get a(): number {
                throw new Error('accessor invoked');
            }
        };
        expect(getOwnField(source, 'a')).toBeUndefined();
    });
});

describe('getOwnCount', () => {
    it('reads an own non-negative safe integer', () => {
        expect(getOwnCount({ a: 0 }, 'a')).toBe(0);
        expect(getOwnCount({ a: 12 }, 'a')).toBe(12);
    });

    it('reads null for a negative, fractional, unsafe, non-number or absent value', () => {
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
            expect(getOwnCount({ a: value }, 'a')).toBeNull();
        }
        expect(getOwnCount({}, 'a')).toBeNull();
    });
});
