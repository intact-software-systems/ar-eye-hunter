import { Either } from '@shared/resilience/Either.ts';
import type { SigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationKeyStore, PublicationKeyStoreFailure } from '@shared/signature/publication-key-store.ts';

export interface InMemoryPublicationKeyStoreFailures {
    readonly read?: PublicationKeyStoreFailure;
    readonly write?: PublicationKeyStoreFailure;
}

/** A browser's session key pairs in memory, keeping the first pair written per session, as the IndexedDB store does. */
export class InMemoryPublicationKeyStore implements PublicationKeyStore {
    readonly pairs = new Map<string, SigningKeyPair>();
    readonly #failures: InMemoryPublicationKeyStoreFailures;

    constructor(failures: InMemoryPublicationKeyStoreFailures = {}) {
        this.#failures = failures;
    }

    async read(sessionId: string): Promise<Either<PublicationKeyStoreFailure, SigningKeyPair | null>> {
        return this.#failures.read === undefined
            ? Either.ofRight(this.pairs.get(sessionId) ?? null)
            : Either.ofLeft(this.#failures.read);
    }

    async write(sessionId: string, keyPair: SigningKeyPair): Promise<Either<PublicationKeyStoreFailure, 'stored'>> {
        if (this.#failures.write !== undefined) {
            return Either.ofLeft(this.#failures.write);
        }
        if (!this.pairs.has(sessionId)) {
            this.pairs.set(sessionId, keyPair);
        }
        return Either.ofRight('stored');
    }
}
