import type { PublicationCrypto } from '../../signature/publication-crypto.ts';
import type { GroupPresencePublicationKey } from '../group-types.ts';

/** The public half of the page's key a presence row registers; `null` for a page without one. */
export function toGroupPresencePublicationKey(
    publicationCrypto: PublicationCrypto
): GroupPresencePublicationKey | null {
    return publicationCrypto.kind === 'available'
        ? { keyId: publicationCrypto.keyPair.keyId, publicJwk: publicationCrypto.keyPair.publicJwk }
        : null;
}
