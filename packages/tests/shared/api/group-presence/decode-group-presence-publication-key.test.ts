import { describe, expect, it } from 'vitest';

import { decodeGroupPresencePublicationKey } from '@shared/api/group-presence/decode-group-presence-publication-key.ts';
import { RFC_7517_PRIVATE_D, RFC_7517_PUBLICATION_KEY } from './group-presence-publication-key-fixtures.ts';

function decodeIssueCodes(value: unknown): readonly string[] {
    return decodeGroupPresencePublicationKey(value).fold(
        (issues) => issues.map((issue) => `${issue.path} ${issue.code}`),
        () => []
    );
}

describe('decodeGroupPresencePublicationKey', () => {
    it('admits a key id and a public P-256 JWK, and null for a page without SubtleCrypto', () => {
        expect(decodeGroupPresencePublicationKey(RFC_7517_PUBLICATION_KEY).right).toEqual(RFC_7517_PUBLICATION_KEY);
        expect(decodeGroupPresencePublicationKey(null).right).toBeNull();
        expect(decodeGroupPresencePublicationKey(null).left).toBeUndefined();
    });

    it('answers missing-publication-key for an absent key, so absence is never read as null', () => {
        expect(decodeIssueCodes(undefined)).toEqual(['$ missing-publication-key']);
    });

    it('refuses a JWK carrying the private member d', () => {
        expect(decodeIssueCodes({
            ...RFC_7517_PUBLICATION_KEY,
            publicJwk: { ...RFC_7517_PUBLICATION_KEY.publicJwk, d: RFC_7517_PRIVATE_D }
        })).toEqual(['$.publicJwk.d unexpected-key']);
    });

    it('refuses a key id that is not 32 bytes of strict base64url', () => {
        for (const keyId of ['', 'short', `${RFC_7517_PUBLICATION_KEY.keyId}A`, 'cn-I_WNMClehiVp51i_0VpOENW1upEerA8sEam5hn+s', 7]) {
            expect(decodeIssueCodes({ ...RFC_7517_PUBLICATION_KEY, keyId })).toEqual(['$.keyId invalid-key-id']);
        }
    });

    it('refuses extra and missing members, a non-object and a malformed JWK', () => {
        expect(decodeIssueCodes({ ...RFC_7517_PUBLICATION_KEY, alg: 'ES256' })).toEqual(['$.alg unexpected-key']);
        expect(decodeIssueCodes({ keyId: RFC_7517_PUBLICATION_KEY.keyId })).toEqual(['$.publicJwk missing-key']);
        expect(decodeIssueCodes('key')).toEqual(['$ invalid-record']);
        expect(decodeIssueCodes([RFC_7517_PUBLICATION_KEY])).toEqual(['$ invalid-record']);
        expect(decodeIssueCodes({ ...RFC_7517_PUBLICATION_KEY, publicJwk: { ...RFC_7517_PUBLICATION_KEY.publicJwk, crv: 'P-384' } }))
            .toEqual(['$.publicJwk.crv invalid-crv']);
        expect(decodeIssueCodes({ ...RFC_7517_PUBLICATION_KEY, publicJwk: 'jwk' })).toEqual(['$.publicJwk invalid-record']);
    });
});
