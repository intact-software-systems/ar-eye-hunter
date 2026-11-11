import type { GroupPresencePublicationKey } from '../api/group-types.ts';
import { LatestRepository } from '../cache/LatestRepository.ts';
import { computeEcdsaP256JwkThumbprint, importEcdsaP256PublicKey } from './ecdsa-p256-signature.ts';

/** One page's imported verification keys, each imported only under the key id its own JWK's thumbprint names. */
export class VerificationKeyCache {
    readonly #keys = new LatestRepository<string, CryptoKey>({ maxEntries: 256 });

    /**
     * The imported key; undefined, and nothing cached, when the thumbprint is not `key.keyId` or WebCrypto refuses the
     * JWK.
     */
    async readVerificationKey(subtle: SubtleCrypto, key: GroupPresencePublicationKey): Promise<CryptoKey | undefined> {
        const cacheKey = `${key.keyId}|${JSON.stringify(key.publicJwk)}`;
        const cached = this.#keys.read(cacheKey);
        if (cached !== undefined) {
            return cached;
        }
        if (await computeEcdsaP256JwkThumbprint(subtle, key.publicJwk) !== key.keyId) {
            return undefined;
        }
        const imported = (await importEcdsaP256PublicKey(subtle, key.publicJwk)).right;
        if (imported !== undefined) {
            this.#keys.accept(cacheKey, imported);
        }
        return imported;
    }
}
