import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
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

/**
 * The page key the RTC fixtures hand their origin and register for every room session, so each recipient a `receiver`
 * or `leader` receipt counts is keyed.
 */
export const ROOM_PUBLICATION_CRYPTO: AvailablePublicationCrypto = await createAvailablePublicationCryptoFixture();

export const ROOM_PUBLICATION_KEY: GroupPresencePublicationKey = {
    keyId: ROOM_PUBLICATION_CRYPTO.keyPair.keyId,
    publicJwk: ROOM_PUBLICATION_CRYPTO.keyPair.publicJwk
};
