import { describe, expect, it } from 'vitest';

import { computeSha256CanonicalJson, serializeCanonicalJson } from '@shared-server/rallar-system/protocol/canonical-json.ts';

describe('canonical JSON identity', () => {
    it('sorts object keys, normalizes negative zero, and omits undefined object fields', () => {
        expect(serializeCanonicalJson({
            zeta: 1,
            omitted: undefined,
            alpha: { value: -0 }
        })).toBe('{"alpha":{"value":0},"zeta":1}');
    });

    it('rejects undefined array entries', () => {
        expect(() => serializeCanonicalJson([undefined]))
            .toThrow('Canonical JSON array entries must be defined');
    });

    it('rejects array accessors before they can affect identity', () => {
        const accessorBackedArray = [1];
        Object.defineProperty(accessorBackedArray, 0, {
            enumerable: true,
            get: () => 2
        });

        expect(() => serializeCanonicalJson(accessorBackedArray))
            .toThrow('Canonical JSON array entries must be enumerable data properties');
    });

    it('rejects cyclic values', () => {
        const cyclicValue: Record<string, object> = {};
        cyclicValue.self = cyclicValue;

        expect(() => serializeCanonicalJson(cyclicValue))
            .toThrow('Canonical JSON value must not contain cycles');
    });

    it('rejects objects whose identity is controlled by a custom prototype', () => {
        expect(() => Reflect.apply(serializeCanonicalJson, undefined, [new Date(0)]))
            .toThrow('Canonical JSON object must use a plain prototype');
    });

    it.each([
        { value: { zeta: 2, alpha: 1 }, digest: '812cbc20509c83d29d2cab078b6076a7569bfcacda070063cf078540328c11a6' },
        { value: {}, digest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' },
        {
            value: ['é', -0, { b: 1, a: null }],
            digest: 'bf2a85247360b7dd27085cb9c2189ce1e9fdafce6d4256052680ece1b9323b0e'
        }
    ])('hashes the UTF-8 serialized lexical-key identity of $value without yielding', ({ value, digest }) => {
        expect(computeSha256CanonicalJson(value)).toBe(digest);
    });
});
