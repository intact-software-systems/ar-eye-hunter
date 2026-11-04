import type { SignatureFailure, SigningKeyPair } from './ecdsa-p256-signature.ts';

/** The page's publication signing capability: WebCrypto with its session's one key pair, or why the page has neither. */
export type PublicationCrypto =
    | Readonly<{ kind: 'available'; subtle: SubtleCrypto; keyPair: SigningKeyPair; }>
    | Readonly<{ kind: 'unavailable'; reason: SignatureFailure['kind']; }>;

/** What a verifier needs of the page: its WebCrypto without a signing key pair, or that the page has none. */
export type PublicationVerificationCrypto =
    | Readonly<{ kind: 'available'; subtle: SubtleCrypto; }>
    | Readonly<{ kind: 'unavailable'; }>;

export function toPublicationVerificationCrypto(subtle: SubtleCrypto | undefined): PublicationVerificationCrypto {
    return subtle === undefined ? { kind: 'unavailable' } : { kind: 'available', subtle };
}
