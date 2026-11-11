import { toGroupPresencePublicationKey } from '@shared/api/group-presence/to-group-presence-publication-key.ts';
import type { GroupPresencePublicationKey } from '@shared/api/group-types.ts';
import { VerificationKeyCache } from '@shared/signature/verification-key-cache.ts';
import { describe, expect, it } from 'vitest';
import { createCountingSubtleCrypto } from './counting-subtle-crypto-fixtures.ts';
import { createAvailablePublicationCryptoFixture } from './publication-crypto-fixtures.ts';

async function createKey(): Promise<GroupPresencePublicationKey> {
    return toGroupPresencePublicationKey(await createAvailablePublicationCryptoFixture())!;
}

describe('VerificationKeyCache', () => {
    it('refuses a key whose JWK thumbprint is not its key id and caches nothing', async () => {
        const [first, second] = [await createKey(), await createKey()];
        const forged = { keyId: first.keyId, publicJwk: second.publicJwk };
        const counting = createCountingSubtleCrypto();
        const cache = new VerificationKeyCache();

        expect(await cache.readVerificationKey(counting.subtle, forged)).toBeUndefined();
        expect(await cache.readVerificationKey(counting.subtle, forged)).toBeUndefined();

        expect(counting.counts.importKey).toBe(0);
        expect(counting.counts.digest).toBe(2);
    });

    it('imports a key once and answers a repeat from the cache', async () => {
        const key = await createKey();
        const counting = createCountingSubtleCrypto();
        const cache = new VerificationKeyCache();

        const first = await cache.readVerificationKey(counting.subtle, key);
        const second = await cache.readVerificationKey(counting.subtle, key);

        expect(first).toBeDefined();
        expect(second).toBe(first);
        expect(counting.counts.importKey).toBe(1);
        expect(counting.counts.digest).toBe(1);
    });

    it('keys an entry by key id and JWK, so a cached key never answers for another JWK under its key id', async () => {
        const [keyA, keyB] = [await createKey(), await createKey()];
        const counting = createCountingSubtleCrypto();
        const cache = new VerificationKeyCache();

        expect(await cache.readVerificationKey(counting.subtle, keyA)).toBeDefined();

        expect(await cache.readVerificationKey(counting.subtle, { keyId: keyA.keyId, publicJwk: keyB.publicJwk }))
            .toBeUndefined();
    });

    it('evicts the oldest key at its 257th', async () => {
        const keys = await Promise.all(Array.from({ length: 257 }, createKey));
        const counting = createCountingSubtleCrypto();
        const cache = new VerificationKeyCache();

        for (const key of keys) {
            await cache.readVerificationKey(counting.subtle, key);
        }
        await cache.readVerificationKey(counting.subtle, keys[0]!);

        expect(counting.counts.importKey).toBe(258);
    });
});
