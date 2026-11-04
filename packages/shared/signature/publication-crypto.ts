import type { SignatureFailure, SigningKeyPair } from './ecdsa-p256-signature.ts';

/** The page's publication signing capability: WebCrypto with the page's one key pair, or why the page has neither. */
export type PublicationCrypto =
    | Readonly<{ kind: 'available'; subtle: SubtleCrypto; keyPair: SigningKeyPair; }>
    | Readonly<{ kind: 'unavailable'; reason: SignatureFailure['kind']; }>;

/** What a verifier needs of the page: its WebCrypto without the signing key pair, or that the page is keyless. */
export type PublicationVerificationCrypto =
    | Readonly<{ kind: 'available'; subtle: SubtleCrypto; }>
    | Readonly<{ kind: 'unavailable'; }>;

export function toPublicationVerificationCrypto(crypto: PublicationCrypto): PublicationVerificationCrypto {
    return crypto.kind === 'available' ? { kind: 'available', subtle: crypto.subtle } : { kind: 'unavailable' };
}
