import { describe, expect, it } from 'vitest';

import {
    arePlainJsonValuesEqual,
    isPlainJsonValue,
    type PlainJsonRecord,
    type PlainJsonValue
} from '@shared/repository/compare-plain-json.ts';

function createNullPrototypeRecord(value: PlainJsonRecord): PlainJsonRecord {
    return Object.assign(Object.create(null) as PlainJsonRecord, value);
}

describe('plain JSON values', () => {
    it.each([
        ['a nested tree', { a: [1, { b: 'b', c: null }], d: true }],
        ['an undefined record value', { a: 1, b: undefined }],
        ['signed zero', -0],
        ['a null-prototype record', createNullPrototypeRecord({ a: 1 })]
    ])('admits %s', (_case, value) => {
        expect(isPlainJsonValue(value)).toBe(true);
    });

    it.each([
        ['an undefined root', undefined],
        ['a nested nonfinite number', [NaN]],
        ['a nested date', { at: new Date(0) }],
        ['a toJSON method', { a: { toJSON: () => 'x' } }],
        ['a function-valued key', { a: 1, f: () => 1 }],
        ['a symbol', Symbol('value')],
        ['a bigint', 1n],
        ['an undefined array entry', [undefined]],
        ['an array hole', Array(1)],
        ['a class instance', new Map()]
    ])('leaves %s to the serialized comparison', (_case, value) => {
        expect(isPlainJsonValue(value)).toBe(false);
    });
});

describe('plain JSON equality', () => {
    it.each(
        [
            ['reordered keys', { b: [1, { d: null, c: 'c' }], a: true }, { a: true, b: [1, { c: 'c', d: null }] }],
            ['undefined values beside absent keys', { a: 1, b: undefined }, { a: 1 }],
            ['signed zero', -0, 0],
            ['an integral float', 1, 1.0],
            ['null-prototype records', createNullPrototypeRecord({ a: 1 }), { a: 1 }]
        ] as const satisfies readonly (readonly [string, PlainJsonValue, PlainJsonValue])[]
    )('equates %s', (_case, left, right) => {
        expect(arePlainJsonValuesEqual(left, right)).toBe(true);
    });

    it.each(
        [
            ['a differing nested leaf', { a: [{ b: 1 }] }, { a: [{ b: 2 }] }],
            ['an added key', { a: 1 }, { a: 1, b: null }],
            ['a number and its string', 1, '1'],
            ['an array and an index record', [1], { 0: 1 }],
            ['array lengths', [1, 2], [1]]
        ] as const satisfies readonly (readonly [string, PlainJsonValue, PlainJsonValue])[]
    )('distinguishes %s', (_case, left, right) => {
        expect(arePlainJsonValuesEqual(left, right)).toBe(false);
    });
});
