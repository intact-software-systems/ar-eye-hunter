import { describe, expect, it } from 'vitest';

import { comparePlainJson, type JsonSerializableValue } from '@shared/repository/compare-plain-json.ts';

describe('plain JSON comparison', () => {
    it.each(
        [
            ['reordered keys', { b: [1, { d: null, c: 'c' }], a: true }, { a: true, b: [1, { c: 'c', d: null }] }],
            ['undefined values beside absent keys', { a: 1, b: undefined }, { a: 1 }],
            ['signed zero', -0, 0],
            ['null-prototype records', Object.assign(Object.create(null) as object, { a: 1 }), { a: 1 }]
        ] as const
    )('decides %s equal', (_case, left, right) => {
        expect(comparePlainJson(left, right)).toBe('equal');
    });

    it.each(
        [
            ['a differing nested leaf', { a: [{ b: 1 }] }, { a: [{ b: 2 }] }],
            ['an added key', { a: 1 }, { a: 1, b: null }],
            ['a number and its string', 1, '1'],
            ['an array and an index record', [1], { 0: 1 }],
            ['array lengths', [1, 2], [1]]
        ] as const
    )('decides %s different', (_case, left, right) => {
        expect(comparePlainJson(left, right)).toBe('different');
    });

    it.each<readonly [string, JsonSerializableValue, JsonSerializableValue]>([
        ['an undefined root', undefined, undefined],
        ['a nonfinite number', [NaN], [null]],
        ['a date', { at: new Date(0) }, { at: {} }],
        ['a toJSON method', { a: { toJSON: () => 'x' } }, { a: 'x' }],
        ['a function-valued key on either side', { a: 1 }, { a: 1, f: () => 1 }],
        ['a bigint', 1n, 1n]
    ])('leaves %s to the serialized comparison', (_case, left, right) => {
        expect(comparePlainJson(left, right)).toBe('not-plain');
    });
});
