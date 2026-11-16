import { describe, expect, it } from 'vitest';

import { getOwnCount, getOwnField } from '@shared/api/topology-plan/get-own-field.ts';

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
