import { describe, expect, it } from 'vitest';

import { getOwnNumber } from '@shared/api/get-own-number.ts';

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
