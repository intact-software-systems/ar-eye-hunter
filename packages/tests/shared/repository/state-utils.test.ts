import {
    describe,
    expect,
    it
} from 'vitest';

import {
    jsonEquals,
    stableJsonStringify,
    toStableJson
} from '@shared/repository/state-utils.ts';

describe('JSON content equality', () => {
    it('preserves a root toJSON method conversion before comparing content', () => {
        const value = {
            Z: 1,
            a: 2,
            toJSON() {
                return Object.keys(this).filter((key) => key !== 'toJSON').join(',');
            }
        };
        expect(stableJsonStringify(value)).toBe('"a,Z"');
        expect(jsonEquals(value, 'a,Z')).toBe(true);
        expect(jsonEquals(value, 'Z,a')).toBe(false);
    });

    it('preserves nested toJSON method conversions inside arrays', () => {
        const value = {
            payload: [{
                Z: 1,
                a: 2,
                toJSON() {
                    return Object.keys(this).filter((key) => key !== 'toJSON').join(',');
                }
            }]
        };
        expect(stableJsonStringify(value)).toBe('{"payload":["a,Z"]}');
        expect(jsonEquals(value, { payload: ['a,Z'] })).toBe(true);
        expect(jsonEquals(value, { payload: ['Z,a'] })).toBe(false);
    });

    it('compares distinct Unicode keys by content after a toJSON method returns an object', () => {
        const value = {
            toJSON() {
                return { payload: [{ ['\u00e9']: 'first', ['e\u0301']: 'second' }] };
            }
        };
        expect(stableJsonStringify(value)).toBe('{"payload":[{"\u00e9":"first","e\u0301":"second"}]}');
        expect(jsonEquals(value, { payload: [{ ['e\u0301']: 'second', ['\u00e9']: 'first' }] })).toBe(true);
        expect(jsonEquals(value, { payload: [{ ['e\u0301']: 'first', ['\u00e9']: 'first' }] })).toBe(false);
    });

    it('converts left then right once even when the converted representations are identical', () => {
        const converted: string[] = [];
        expect(jsonEquals({
            toJSON() {
                converted.push('left');
                return 'same';
            }
        }, {
            toJSON() {
                converted.push('right');
                return 'same';
            }
        })).toBe(true);
        expect(converted).toEqual(['left', 'right']);
    });

    it('keeps an unserialized hook outcome distinct from serialized null in either position', () => {
        const value = {
            toJSON() {
                return undefined;
            }
        };
        expect(stableJsonStringify(value)).toBeUndefined();
        expect(jsonEquals(value, undefined)).toBe(true);
        expect(jsonEquals(value, null)).toBe(false);
        expect(jsonEquals(null, value)).toBe(false);
    });

    it('propagates a left conversion failure before evaluating the right value', () => {
        const converted: string[] = [];
        const failure = new Error('left conversion failed');
        expect(() =>
            jsonEquals({
                toJSON() {
                    converted.push('left');
                    throw failure;
                }
            }, {
                toJSON() {
                    converted.push('right');
                    return 'same';
                }
            })
        ).toThrow(failure);
        expect(converted).toEqual(['left']);
    });

    it('propagates a right conversion failure after converting the left value', () => {
        const converted: string[] = [];
        const failure = new Error('right conversion failed');
        expect(() =>
            jsonEquals({
                toJSON() {
                    converted.push('left');
                    return 'same';
                }
            }, {
                toJSON() {
                    converted.push('right');
                    throw failure;
                }
            })
        ).toThrow(failure);
        expect(converted).toEqual(['left', 'right']);
    });

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
