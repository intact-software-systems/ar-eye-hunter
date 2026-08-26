import { describe, expect, it } from 'vitest';

import { serializeCanonicalJson, sha256CanonicalJson } from '@shared-server/rallar-system/protocol/canonical-json.ts';

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

    it('hashes the serialized lexical-key identity', async () => {
        await expect(sha256CanonicalJson({ zeta: 2, alpha: 1 })).resolves.toBe(
            '812cbc20509c83d29d2cab078b6076a7569bfcacda070063cf078540328c11a6'
        );
    });
});
