import { createSigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationCrypto } from '@shared/signature/publication-crypto.ts';

export type AvailablePublicationCrypto = Extract<PublicationCrypto, { kind: 'available'; }>;

export const UNAVAILABLE_PUBLICATION_CRYPTO: PublicationCrypto = { kind: 'unavailable', reason: 'subtle-unavailable' };

/** A page key over the test runtime's WebCrypto, fresh per call as a page's is. */
export async function createAvailablePublicationCryptoFixture(): Promise<AvailablePublicationCrypto> {
    const subtle = globalThis.crypto.subtle;
    return (await createSigningKeyPair(subtle)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (keyPair) => ({ kind: 'available', subtle, keyPair })
    );
}
