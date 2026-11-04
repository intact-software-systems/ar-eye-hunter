import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultPublicationKeyStore } from '@shared-web/browser/composition/create-default-publication-key-store.ts';
import { waitForIndexedDbTransaction } from '@shared/persistence/indexed-db-request.ts';
import { openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import {
    createSigningKeyPair,
    importEcdsaP256PublicKey,
    signDetached,
    verifyDetached,
    type SigningKeyPair
} from '@shared/signature/ecdsa-p256-signature.ts';
import { readOrCreatePublicationCrypto } from '@shared/signature/read-or-create-publication-crypto.ts';

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

describe('a stored session pair that does not decode', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each<[string, (sessionId: string) => Promise<object>]>([
        ['a record without a key pair', async (sessionId) => ({ sessionId, junk: true })],
        ['an ECDSA P-384 private key', async (sessionId) => ({
            sessionId,
            keyPair: await createForeignKeyPair({ name: 'ECDSA', namedCurve: 'P-384' }, ['sign'])
        })],
        ['an ECDH P-256 private key that cannot sign', async (sessionId) => ({
            sessionId,
            keyPair: await createForeignKeyPair({ name: 'ECDH', namedCurve: 'P-256' }, ['deriveBits'])
        })]
    ])('is read as absent and replaced by the first valid pair: %s', async (label, toRecord) => {
        const sessionId = `undecodable-${label}`;
        await putStoredRecord(await toRecord(sessionId));
        const warnings = captureWarnings();

        const first = await readOrCreatePublicationCrypto({ subtle, store: createDefaultPublicationKeyStore(), sessionId });
        const second = await readOrCreatePublicationCrypto({ subtle, store: createDefaultPublicationKeyStore(), sessionId });

        expect(first.kind === 'available' && first.keyPair.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.kind === 'available' && second.keyPair.keyId).toBe(first.kind === 'available' && first.keyPair.keyId);
        expect((await createDefaultPublicationKeyStore().read(sessionId)).right?.keyId).toBe(
            first.kind === 'available' ? first.keyPair.keyId : undefined
        );
        expect(warnings).toStrictEqual([[`The stored publication key pair of ${sessionId} does not decode; it is read as absent.`]]);
    });
});

/** A record as an older or corrupted page left it, written past the store's own write. */
async function putStoredRecord(record: object): Promise<void> {
    const db = await openIndexedDbWithStores('rallar-publication-keys', [{ name: 'session-key-pairs', keyPath: 'sessionId' }]);
    const transaction = db.transaction('session-key-pairs', 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore('session-key-pairs').put(record);
    await completed;
    db.close();
}

/** A pair shaped like a session pair whose private key is not the P-256 signing key the store keeps. */
async function createForeignKeyPair(algorithm: EcKeyGenParams, usages: KeyUsage[]): Promise<object> {
    const valid = await createKeyPair();
    const foreign = await subtle.generateKey(algorithm, false, usages);
    return { ...valid, privateKey: foreign.privateKey };
}

function captureWarnings(): string[][] {
    const warnings: string[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...messages: string[]) => {
        warnings.push(messages);
    });
    return warnings;
}

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
