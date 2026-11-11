import { isSameSignatureProof } from '@shared/signature/signature-proof.ts';
import { describe, expect, it } from 'vitest';

import { toTestSignatureProof } from '../../al-control-test-payloads.ts';

describe('isSameSignatureProof', () => {
    it('is one identity for two absent proofs, and for two proofs of one key id and signature', () => {
        expect(isSameSignatureProof(null, null)).toBe(true);
        expect(isSameSignatureProof(toTestSignatureProof(1), { ...toTestSignatureProof(1) })).toBe(true);
    });

    it('is two identities when the key id or the signature differs, or only one is absent', () => {
        const proof = toTestSignatureProof(1);

        expect(isSameSignatureProof(proof, { ...proof, keyId: 'B'.repeat(43) })).toBe(false);
        expect(isSameSignatureProof(proof, toTestSignatureProof(2))).toBe(false);
        expect(isSameSignatureProof(proof, null)).toBe(false);
        expect(isSameSignatureProof(null, proof)).toBe(false);
    });
});
