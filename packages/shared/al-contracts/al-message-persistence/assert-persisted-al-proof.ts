import { isBase64UrlOfByteLength } from '../../encoding/base64url.ts';
import { ECDSA_P256_KEY_ID_BYTES, ECDSA_P256_SIGNATURE_BYTES } from '../../signature/ecdsa-p256-signature.ts';
import {
    requirePersistedALFields,
    requirePersistedALRecord,
    type PersistedALValue
} from './persisted-al-value-validation.ts';

/** Exactly `alg`, `keyId` and `signature`: ES256, a 43-character key id and an 86-character signature in strict base64url. */
export function assertPersistedALProof(value: PersistedALValue): void {
    const proof = requirePersistedALRecord(value, 'proof');
    requirePersistedALFields(proof, ['alg', 'keyId', 'signature'], ['alg', 'keyId', 'signature']);
    if (proof.alg !== 'ES256') {
        throw new TypeError('Persisted AL proof algorithm is invalid');
    }
    if (!isBase64UrlOfByteLength(proof.keyId, ECDSA_P256_KEY_ID_BYTES)) {
        throw new TypeError('Persisted AL proof key id is invalid');
    }
    if (!isBase64UrlOfByteLength(proof.signature, ECDSA_P256_SIGNATURE_BYTES)) {
        throw new TypeError('Persisted AL proof signature is invalid');
    }
}
