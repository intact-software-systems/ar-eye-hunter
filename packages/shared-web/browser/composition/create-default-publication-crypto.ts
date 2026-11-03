import { createSigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

/**
 * The page's one key pair, never stored; the only browser read of `globalThis.crypto.subtle`. The RTC publication
 * proof verifier (`RtcPublicationProofVerifierPort`) is composed beside it, from the same value.
 */
export async function createDefaultPublicationCrypto(): Promise<PublicationCrypto> {
    const publicationCrypto = await createPublicationCrypto(globalThis.crypto?.subtle);
    if (publicationCrypto.kind === 'unavailable') {
        console.warn(`Publication signing is unavailable: ${publicationCrypto.reason}.`);
    }
    return publicationCrypto;
}

async function createPublicationCrypto(subtle: SubtleCrypto | undefined): Promise<PublicationCrypto> {
    if (subtle === undefined) {
        return { kind: 'unavailable', reason: 'subtle-unavailable' };
    }
    return (await createSigningKeyPair(subtle)).fold<PublicationCrypto>(
        (failure) => ({ kind: 'unavailable', reason: failure.kind }),
        (keyPair) => ({ kind: 'available', subtle, keyPair })
    );
}
