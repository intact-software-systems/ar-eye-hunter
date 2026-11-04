import { createSigningKeyPair, type SignatureFailure, type SigningKeyPair } from './ecdsa-p256-signature.ts';
import type { PublicationCrypto } from './publication-crypto.ts';
import type { PublicationKeyStore, PublicationKeyStoreFailure } from './publication-key-store.ts';

export interface ReadOrCreatePublicationCryptoInput {
    readonly subtle: SubtleCrypto | undefined;
    readonly store: PublicationKeyStore;
    readonly sessionId: string;
}

/**
 * The session's one key pair over the page's WebCrypto: the pair a page of the session stored, or a new pair stored
 * for its other pages. A failing store leaves the page signing with a pair of its own, which only it registers.
 */
export async function readOrCreatePublicationCrypto(
    input: ReadOrCreatePublicationCryptoInput
): Promise<PublicationCrypto> {
    const { subtle } = input;
    if (subtle === undefined) {
        return toUnavailablePublicationCrypto('subtle-unavailable');
    }
    const stored = await input.store.read(input.sessionId);
    if (stored.right) {
        return { kind: 'available', subtle, keyPair: stored.right };
    }
    return await (await createSigningKeyPair(subtle)).fold<Promise<PublicationCrypto>>(
        async (failure) => toUnavailablePublicationCrypto(failure.kind),
        async (keyPair) => ({
            kind: 'available',
            subtle,
            keyPair: stored.left === undefined
                ? await writeSessionKeyPair(input, keyPair)
                : keepPageKeyPair(stored.left, keyPair)
        })
    );
}

/** The pair the session holds once this page offered its own: its own, or the one another page stored first. */
async function writeSessionKeyPair(
    input: ReadOrCreatePublicationCryptoInput,
    keyPair: SigningKeyPair
): Promise<SigningKeyPair> {
    const written = await input.store.write(input.sessionId, keyPair);
    if (written.left !== undefined) {
        return keepPageKeyPair(written.left, keyPair);
    }
    return (await input.store.read(input.sessionId)).right ?? keyPair;
}

function keepPageKeyPair(failure: PublicationKeyStoreFailure, keyPair: SigningKeyPair): SigningKeyPair {
    console.warn(`Publication key ${failure.kind}: ${failure.detail}; this page signs with a key of its own.`);
    return keyPair;
}

function toUnavailablePublicationCrypto(reason: SignatureFailure['kind']): PublicationCrypto {
    console.warn(`Publication signing is unavailable: ${reason}.`);
    return { kind: 'unavailable', reason };
}
