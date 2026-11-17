import {
    describe,
    expect,
    it
} from 'vitest';

import { serializeCanonicalJson } from '@shared/encoding/canonical-json.ts';

describe('canonical JSON serialization', () => {
    it('sorts object keys, normalizes negative zero, and omits undefined object fields', () => {
        expect(serializeCanonicalJson({
            zeta: 1,
            omitted: undefined,
            alpha: { value: -0 }
        })).toBe('{"alpha":{"value":0},"zeta":1}');
    });

    it('keeps array order while sorting the keys of nested objects', () => {
        expect(serializeCanonicalJson(['é', -0, { b: 1, a: null }])).toBe('["é",0,{"a":null,"b":1}]');
    });

    it('accepts null-prototype records without inheriting object properties', () => {
        const record = Object.create(null, {
            zeta: { enumerable: true, value: true },
            alpha: { enumerable: true, value: 'value' }
        });

        expect(serializeCanonicalJson(record)).toBe('{"alpha":"value","zeta":true}');
    });

    it('accepts shared references that do not form a cycle', () => {
        const sharedValue = { zeta: 2, alpha: 1 };

        expect(serializeCanonicalJson({ b: sharedValue, a: [sharedValue, sharedValue] }))
            .toBe('{"a":[{"alpha":1,"zeta":2},{"alpha":1,"zeta":2}],"b":{"alpha":1,"zeta":2}}');
    });

    it.each([NaN, Infinity, -Infinity])('rejects non-finite number %s at root and nested boundaries', (value) => {
        expect(() => serializeCanonicalJson(value)).toThrow('Canonical JSON number must be finite');
        expect(() => serializeCanonicalJson({ value })).toThrow('Canonical JSON number must be finite');
        expect(() => serializeCanonicalJson([value])).toThrow('Canonical JSON number must be finite');
    });

    it('rejects undefined array entries', () => {
        expect(() => serializeCanonicalJson([undefined]))
            .toThrow('Canonical JSON array entries must be defined');
    });

    it('rejects array accessors before they can affect identity', () => {
        const accessorBackedArray = [1];
        let getterCalls = 0;
        Object.defineProperty(accessorBackedArray, 0, {
            enumerable: true,
            get: () => {
                getterCalls += 1;
                return 2;
            }
        });

        expect(() => serializeCanonicalJson(accessorBackedArray))
            .toThrow('Canonical JSON array entries must be enumerable data properties');
        expect(getterCalls).toBe(0);
    });

    it('rejects sparse arrays instead of silently losing a position', () => {
        const sparseArray = [1, 2];
        delete sparseArray[0];

        expect(() => serializeCanonicalJson(sparseArray)).toThrow('Canonical JSON array must be dense');
    });

    it.each(['extra', '01', Symbol('extra')])('rejects non-index array key %s', (key) => {
        const array = [1];
        Object.defineProperty(array, key, { enumerable: true, value: 2 });

        expect(() => serializeCanonicalJson(array)).toThrow('Canonical JSON array must only contain indexed entries');
    });

    it('rejects non-enumerable array entries', () => {
        const array = [1];
        Object.defineProperty(array, 0, { enumerable: false });

        expect(() => serializeCanonicalJson(array))
            .toThrow('Canonical JSON array entries must be enumerable data properties');
    });

    it('rejects arrays with a nonstandard prototype', () => {
        const array = [1];
        Object.setPrototypeOf(array, null);

        expect(() => serializeCanonicalJson(array)).toThrow('Canonical JSON array must use the standard prototype');
    });

    it('rejects symbol object keys instead of omitting them from identity', () => {
        expect(() => serializeCanonicalJson({ [Symbol('key')]: 1 }))
            .toThrow('Canonical JSON object must not contain symbol keys');
    });

    it('rejects non-enumerable object properties', () => {
        const object = Object.defineProperty({}, 'hidden', { value: 1 });

        expect(() => serializeCanonicalJson(object))
            .toThrow('Canonical JSON object properties must be enumerable data properties');
    });

    it('rejects object accessors without executing them', () => {
        let getterCalls = 0;
        const object = {
            get value() {
                getterCalls += 1;
                return 1;
            }
        };

        expect(() => serializeCanonicalJson(object))
            .toThrow('Canonical JSON object properties must be enumerable data properties');
        expect(getterCalls).toBe(0);
    });

    it.each([
        ['function', () => 1],
        ['symbol', Symbol('value')],
        ['bigint', 1n]
    ])('rejects unsupported %s object values', (_kind, value) => {
        expect(() => serializeCanonicalJson({ nested: { value } }))
            .toThrow('Canonical JSON object contains an unsupported value');
    });

    it('rejects cyclic objects', () => {
        const cyclicValue: Record<string, object> = {};
        cyclicValue.self = cyclicValue;

        expect(() => serializeCanonicalJson(cyclicValue))
            .toThrow('Canonical JSON value must not contain cycles');
    });

    it('rejects cycles through arrays', () => {
        const cyclicArray: object[] = [];
        cyclicArray.push({ back: cyclicArray });

        expect(() => serializeCanonicalJson(cyclicArray)).toThrow('Canonical JSON value must not contain cycles');
    });

    it('rejects objects whose identity is controlled by a custom prototype', () => {
        expect(() => serializeCanonicalJson(new Date(0)))
            .toThrow('Canonical JSON object must use a plain prototype');
    });
});
