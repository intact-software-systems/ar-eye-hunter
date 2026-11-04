import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';
import type { PublicationKeyStore } from '@shared/signature/publication-key-store.ts';
import { readOrCreatePublicationCrypto } from '@shared/signature/read-or-create-publication-crypto.ts';

export namespace SessionPublicationCrypto {
    export interface Input {
        /** The page's WebCrypto; without it every session's page is keyless. */
        readonly subtle: SubtleCrypto | undefined;
        /** Where the pages of a session share its key pair. */
        readonly store: PublicationKeyStore;
    }
}

/**
 * The page's signing crypto for the session it is signed into: read once per session, and again after a session
 * change.
 */
export class SessionPublicationCrypto {
    readonly #input: SessionPublicationCrypto.Input;
    #current: Readonly<{ sessionId: string; crypto: Promise<PublicationCrypto>; }> | undefined;

    constructor(input: SessionPublicationCrypto.Input) {
        this.#input = input;
    }

    read(sessionId: string): Promise<PublicationCrypto> {
        if (this.#current?.sessionId !== sessionId) {
            this.#current = {
                sessionId,
                crypto: readOrCreatePublicationCrypto({
                    subtle: this.#input.subtle,
                    store: this.#input.store,
                    sessionId
                })
            };
        }
        return this.#current.crypto;
    }
}
