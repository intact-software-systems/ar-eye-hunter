import { createSigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

/**
 * The page's one key pair, never stored; the only read of `globalThis.crypto.subtle` for publication signing. The RTC
 * publication proof verifier (`RtcPublicationProofVerifierPort`) is to be composed beside it from the same value.
 */
export async function createDefaultPublicationCrypto(): Promise<PublicationCrypto> {
    const subtle = globalThis.crypto?.subtle;
    const publicationCrypto = (await createSigningKeyPair(subtle)).fold<PublicationCrypto>(
        (failure) => ({ kind: 'unavailable', reason: failure.kind }),
        (keyPair) => ({ kind: 'available', subtle, keyPair })
    );
    if (publicationCrypto.kind === 'unavailable') {
        console.warn(`Publication signing is unavailable: ${publicationCrypto.reason}.`);
    }
    return publicationCrypto;
}
