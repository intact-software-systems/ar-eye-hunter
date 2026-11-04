import { isBase64UrlOfByteLength } from '@shared/encoding/base64url.ts';
import {
    readIndexedDbRequest,
    readIndexedDbTransaction,
    waitForIndexedDbTransaction
} from '@shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection, openIndexedDbWithStores } from '@shared/persistence/open-indexed-db.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    decodeEcdsaP256PublicJwk,
    ECDSA_P256_KEY_ID_BYTES,
    type SigningKeyPair
} from '@shared/signature/ecdsa-p256-signature.ts';
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
    const decoded = decodeStoredPublicationKeyPair(
        await readIndexedDbTransaction(
            transaction,
            async () => await readIndexedDbRequest(transaction.objectStore(PUBLICATION_KEY_STORE_NAME).get(sessionId))
        ),
        sessionId
    );
    if (decoded.left === 'undecodable') {
        console.warn(`The stored publication key pair of ${sessionId} does not decode; it is read as absent.`);
    }
    return Either.ofRight(decoded.right ?? null);
}

/**
 * One read-write transaction, so of two pages writing at once only the first stores its pair; a stored record that
 * does not decode counts as none, so the first valid pair replaces it.
 */
async function writeFirstPublicationKeyPair(db: IDBDatabase, stored: StoredPublicationKeyPair): Promise<void> {
    const transaction = db.transaction(PUBLICATION_KEY_STORE_NAME, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(PUBLICATION_KEY_STORE_NAME);
    const existing = store.get(stored.sessionId);
    existing.onsuccess = () => {
        if (decodeStoredPublicationKeyPair(existing.result, stored.sessionId).right === undefined) {
            store.put(stored);
        }
    };
    await completed;
}

/** The session's pair, or why there is none: no record, or a record that is not a P-256 signing pair of this session. */
function decodeStoredPublicationKeyPair(
    value: unknown,
    sessionId: string
): Either<'absent' | 'undecodable', SigningKeyPair> {
    if (value === undefined) {
        return Either.ofLeft('absent');
    }
    const stored = value as Partial<StoredPublicationKeyPair> | null;
    const keyPair = stored?.keyPair as Partial<SigningKeyPair> | undefined;
    const publicJwk = decodeEcdsaP256PublicJwk(keyPair?.publicJwk).right;
    if (
        stored?.sessionId !== sessionId ||
        !isEcdsaP256SigningKey(keyPair?.privateKey) ||
        typeof keyPair.keyId !== 'string' ||
        !isBase64UrlOfByteLength(keyPair.keyId, ECDSA_P256_KEY_ID_BYTES) ||
        publicJwk === undefined
    ) {
        return Either.ofLeft('undecodable');
    }
    return Either.ofRight({ privateKey: keyPair.privateKey, publicJwk, keyId: keyPair.keyId });
}

function isEcdsaP256SigningKey(key: unknown): key is CryptoKey {
    return key instanceof CryptoKey &&
        key.type === 'private' &&
        key.algorithm.name === 'ECDSA' &&
        (key.algorithm as EcKeyAlgorithm).namedCurve === 'P-256' &&
        key.usages.includes('sign');
}
