import { describe, expect, it } from 'vitest';

import { decodeGroupPresencePublicationKey } from '@shared/api/group-presence/decode-group-presence-publication-key.ts';
import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import {
    createAvailablePublicationCryptoFixture,
    UNAVAILABLE_PUBLICATION_CRYPTO
} from '../../signature/publication-crypto-fixtures.ts';

describe('toGroupPresencePublicationKey', () => {
    it('registers the public half of an available page key under its key id, which the presence decoder admits', async () => {
        const publicationCrypto = await createAvailablePublicationCryptoFixture();

        const publicationKey = toGroupPresencePublicationKey(publicationCrypto);

        expect(publicationKey).toStrictEqual({
            keyId: publicationCrypto.keyPair.keyId,
            publicJwk: publicationCrypto.keyPair.publicJwk
        });
        expect(decodeGroupPresencePublicationKey(JSON.parse(JSON.stringify(publicationKey))).right)
            .toStrictEqual(publicationKey);
    });

    it('registers no key for a page without WebCrypto', () => {
        expect(toGroupPresencePublicationKey(UNAVAILABLE_PUBLICATION_CRYPTO)).toBeNull();
    });
});
