import { describe, expect, it } from 'vitest';

import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';

describe('canonical JSON SHA-256 identity', () => {
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
