export interface SignatureProof {
    readonly alg: 'ES256';
    readonly keyId: string;
    readonly signature: string;
}

/** Two proofs are one identity when both are absent or they carry the same key id and signature. */
export function isSameSignatureProof(left: SignatureProof | null, right: SignatureProof | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return left.keyId === right.keyId && left.signature === right.signature;
}
