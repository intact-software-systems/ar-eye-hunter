import type { Either } from '../resilience/Either.ts';
import type { SigningKeyPair } from './ecdsa-p256-signature.ts';

export type PublicationKeyStoreFailure = Readonly<{
    kind: 'storage-unavailable' | 'storage-failed';
    detail: string;
}>;

/** Where the pages of one session keep the session's one signing key pair, so each of them signs with it. */
export interface PublicationKeyStore {
    /** The pair stored for the session, or null when none is. */
    read(sessionId: string): Promise<Either<PublicationKeyStoreFailure, SigningKeyPair | null>>;
    /** Stores the pair unless the session already has one: the first pair stored stays the session's. */
    write(sessionId: string, keyPair: SigningKeyPair): Promise<Either<PublicationKeyStoreFailure, 'stored'>>;
}
