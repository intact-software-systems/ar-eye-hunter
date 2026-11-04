import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultPublicationKeyStore } from '@shared-web/browser/composition/create-default-publication-key-store.ts';
import {
    createSigningKeyPair,
    importEcdsaP256PublicKey,
    signDetached,
    verifyDetached,
    type SigningKeyPair
} from '@shared/signature/ecdsa-p256-signature.ts';

const subtle = globalThis.crypto.subtle;

describe('the browser\'s session publication key pairs in IndexedDB', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('hands another page of the session the stored pair, its private key still non-extractable and signing', async () => {
        const keyPair = await createKeyPair();
        expect((await createDefaultPublicationKeyStore().write('round-trip', keyPair)).right).toBe('stored');

        const read = (await createDefaultPublicationKeyStore().read('round-trip')).right;

        expect(read?.keyId).toBe(keyPair.keyId);
        expect(read?.publicJwk).toStrictEqual(keyPair.publicJwk);
        expect(read?.privateKey).toMatchObject({ type: 'private', extractable: false });
        expect(read === null || read === undefined ? undefined : await signsForPublicJwk(read)).toBe('verified');
    });

    it('reads null for a session no page stored a pair for', async () => {
        expect((await createDefaultPublicationKeyStore().read('never-stored')).right).toBeNull();
    });

    it('keeps the first pair stored for a session when another page writes its own', async () => {
        const [first, second] = [await createKeyPair(), await createKeyPair()];
        const store = createDefaultPublicationKeyStore();

        await Promise.all([store.write('first-wins', first), createDefaultPublicationKeyStore().write('first-wins', second)]);

        expect((await store.read('first-wins')).right?.keyId).toBe(first.keyId);
    });

    it('leaves the pairs of other sessions stored', async () => {
        const [earlier, later] = [await createKeyPair(), await createKeyPair()];
        const store = createDefaultPublicationKeyStore();

        await store.write('earlier-session', earlier);
        await store.write('later-session', later);

        expect((await store.read('earlier-session')).right?.keyId).toBe(earlier.keyId);
        expect((await store.read('later-session')).right?.keyId).toBe(later.keyId);
    });

    it('answers storage-unavailable without IndexedDB', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const store = createDefaultPublicationKeyStore();

        expect((await store.read('no-indexeddb')).left?.kind).toBe('storage-unavailable');
        expect((await store.write('no-indexeddb', await createKeyPair())).left?.kind).toBe('storage-unavailable');
    });
});

async function createKeyPair(): Promise<SigningKeyPair> {
    return (await createSigningKeyPair(subtle)).fold(
        (failure) => {
            throw new Error(failure.message);
        },
        (keyPair) => keyPair
    );
}

async function signsForPublicJwk(keyPair: SigningKeyPair): Promise<string | undefined> {
    const bytes = new TextEncoder().encode('granted frame bytes');
    const signature = (await signDetached(subtle, keyPair.privateKey, bytes)).right;
    const publicKey = (await importEcdsaP256PublicKey(subtle, keyPair.publicJwk)).right;
    if (signature === undefined || publicKey === undefined) {
        return undefined;
    }
    return (await verifyDetached({ subtle, publicKey, bytes, signature })).right;
}
