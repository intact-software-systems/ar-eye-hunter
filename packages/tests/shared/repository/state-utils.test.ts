import { describe, expect, it } from 'vitest';

import { jsonEquals, stableJsonStringify, toStableJson } from '@shared/repository/state-utils.ts';

describe('JSON content equality', () => {
    it('compares distinct collation-equivalent keys recursively without depending on insertion order', () => {
        expect(jsonEquals(
            { payload: [{ ['\u00e9']: 'first', ['e\u0301']: 'second' }] },
            { payload: [{ ['e\u0301']: 'second', ['\u00e9']: 'first' }] }
        )).toBe(true);
    });

    it.each([
        ['distinct Unicode keys', { ['\u00e9']: 'first' }, { ['e\u0301']: 'first' }],
        ['changed Unicode value', { ['\u00e9']: 'first', ['e\u0301']: 'second' }, { ['e\u0301']: 'first', ['\u00e9']: 'first' }],
        ['removed Unicode key', { ['\u00e9']: 'first', ['e\u0301']: 'second' }, { ['\u00e9']: 'first' }],
        ['array order', [{ ['\u00e9']: 'first' }, { ['e\u0301']: 'second' }], [{ ['e\u0301']: 'second' }, { ['\u00e9']: 'first' }]]
    ])('distinguishes %s', (_change, left, right) => {
        expect(jsonEquals(left, right)).toBe(false);
    });

    it.each([
        ['omitted object values', { missing: undefined, method: () => 1, symbol: Symbol('value') }, {}],
        ['null array entries', [undefined, () => 1, Symbol('value'), NaN, Infinity], [null, null, null, null, null]],
        ['sparse array entries', Array(2), [null, null]],
        ['nonfinite numbers', NaN, null],
        ['signed zero', -0, 0],
        ['objects without enumerable data', new Date(0), {}],
        ['unserialized root values', undefined, Symbol('value')]
    ])('retains the existing JSON conversion of %s', (_conversion, left, right) => {
        expect(jsonEquals(left, right)).toBe(true);
    });

    it('still refuses BigInt serialization', () => {
        expect(() => jsonEquals(1n, 1n)).toThrow(TypeError);
        expect(() => stableJsonStringify(1n)).toThrow(TypeError);
    });
});

describe('persisted stable JSON serialization', () => {
    it('retains historical locale ordering recursively', () => {
        const value = { payload: [{ Z: 1, a: 2 }] };
        expect(stableJsonStringify(value)).toBe('{"payload":[{"a":2,"Z":1}]}');
        expect(Object.keys((toStableJson(value) as typeof value).payload[0])).toEqual(['a', 'Z']);
    });

    it.each([
        [{ payload: { ['\u00e9']: 'first', ['e\u0301']: 'second' } }, '{"payload":{"\u00e9":"first","e\u0301":"second"}}'],
        [{ payload: { ['e\u0301']: 'second', ['\u00e9']: 'first' } }, '{"payload":{"e\u0301":"second","\u00e9":"first"}}']
    ])('retains the historical bytes for collation-equivalent keys %#', (value, serialized) => {
        expect(stableJsonStringify(value)).toBe(serialized);
    });
});
