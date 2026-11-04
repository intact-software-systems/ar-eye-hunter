import {
    readIndexedDbRequest,
    readIndexedDbTransaction,
    waitForIndexedDbTransaction
} from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { decodeEcdsaP256PublicJwk, type SigningKeyPair } from '@shared/signature/ecdsa-p256-signature.ts';
import type { PublicationKeyStore, PublicationKeyStoreFailure } from '@shared/signature/publication-key-store.ts';

const PUBLICATION_KEY_DB_NAME = 'rallar-publication-keys';
const PUBLICATION_KEY_STORE_NAME = 'session-key-pairs';

interface StoredPublicationKeyPair {
    readonly sessionId: string;
    readonly keyPair: SigningKeyPair;
}

/**
 * The session key pairs every page of this origin shares, in IndexedDB, structured-cloned with their non-extractable
 * private keys. A pair outlives its session: one per session this browser held, until site data is cleared.
 */
export function createDefaultPublicationKeyStore(): PublicationKeyStore {
    const connection = new IndexedDbConnection(() =>
        openIndexedDbWithStores(PUBLICATION_KEY_DB_NAME, [{ name: PUBLICATION_KEY_STORE_NAME, keyPath: 'sessionId' }])
    );
    return {
        read: (sessionId) =>
            runPublicationKeyStoreOperation(async () =>
                await readStoredPublicationKeyPair(await connection.open(), sessionId)
            ),
        write: (sessionId, keyPair) =>
            runPublicationKeyStoreOperation(async () => {
                await writeFirstPublicationKeyPair(await connection.open(), { sessionId, keyPair });
                return Either.ofRight('stored');
            })
    };
}

async function runPublicationKeyStoreOperation<Result>(
    operation: () => Promise<Either<PublicationKeyStoreFailure, Result>>
): Promise<Either<PublicationKeyStoreFailure, Result>> {
    if (typeof indexedDB === 'undefined') {
        return Either.ofLeft({
            kind: 'storage-unavailable',
            detail: 'IndexedDB is not supported in this environment.'
        });
    }
    try {
        return await operation();
    }
    catch (error) {
        return Either.ofLeft({ kind: 'storage-failed', detail: toError(error).message });
    }
}

async function readStoredPublicationKeyPair(
    db: IDBDatabase,
    sessionId: string
): Promise<Either<PublicationKeyStoreFailure, SigningKeyPair | null>> {
    const transaction = db.transaction(PUBLICATION_KEY_STORE_NAME, 'readonly');
    return decodeStoredPublicationKeyPair(
        await readIndexedDbTransaction(
            transaction,
            async () => await readIndexedDbRequest(transaction.objectStore(PUBLICATION_KEY_STORE_NAME).get(sessionId))
        ),
        sessionId
    );
}

/** One read-write transaction, so of two pages writing at once only the first stores its pair. */
async function writeFirstPublicationKeyPair(db: IDBDatabase, stored: StoredPublicationKeyPair): Promise<void> {
    const transaction = db.transaction(PUBLICATION_KEY_STORE_NAME, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(PUBLICATION_KEY_STORE_NAME);
    const existing = store.get(stored.sessionId);
    existing.onsuccess = () => {
        if (existing.result === undefined) {
            store.put(stored);
        }
    };
    await completed;
}

function decodeStoredPublicationKeyPair(
    value: unknown,
    sessionId: string
): Either<PublicationKeyStoreFailure, SigningKeyPair | null> {
    if (value === undefined) {
        return Either.ofRight(null);
    }
    const stored = value as Partial<StoredPublicationKeyPair> | null;
    const keyPair = stored?.keyPair as Partial<SigningKeyPair> | undefined;
    const publicJwk = decodeEcdsaP256PublicJwk(keyPair?.publicJwk).right;
    if (
        stored?.sessionId !== sessionId ||
        !(keyPair?.privateKey instanceof CryptoKey) ||
        keyPair.privateKey.type !== 'private' ||
        typeof keyPair.keyId !== 'string' ||
        publicJwk === undefined
    ) {
        return Either.ofLeft({ kind: 'storage-failed', detail: `The stored key pair of ${sessionId} is malformed.` });
    }
    return Either.ofRight({ privateKey: keyPair.privateKey, publicJwk, keyId: keyPair.keyId });
}
