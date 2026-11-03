import type { SignatureFailure, SigningKeyPair } from './ecdsa-p256-signature.ts';

/** The page's publication signing capability: WebCrypto with the page's one key pair, or why the page has neither. */
export type PublicationCrypto =
    | Readonly<{ kind: 'available'; subtle: SubtleCrypto; keyPair: SigningKeyPair; }>
    | Readonly<{ kind: 'unavailable'; reason: SignatureFailure['kind']; }>;
