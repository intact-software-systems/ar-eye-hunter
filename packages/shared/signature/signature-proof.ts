export interface SignatureProof {
    readonly alg: 'ES256';
    readonly keyId: string;
    readonly signature: string;
}
