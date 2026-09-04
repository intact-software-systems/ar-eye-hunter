import { decodeALAdmissionStoredValue } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError, decodeALAdmissionValue } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionNumber } from '@shared/alm/al-admission-value-validation.ts';
import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { AL_ADMISSION_REVISION_KEY } from '@shared/alm/indexed-db-admission-backend.ts';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserSessionALRuntimeEntryKeyPrefixes
} from './browser-al-runtime-identity.ts';

export const BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

interface BrowserALRuntimeCleanupRead {
    readonly revision: number;
    readonly rows: readonly Readonly<{ key: string; value: unknown; }>[];
}

interface BrowserALRuntimeCleanupComputed {
    readonly deleteKeys: readonly string[];
    readonly revisionWrite: Readonly<{
        key: typeof AL_ADMISSION_REVISION_KEY;
        value: number;
        expireAtTimestamp: number;
    }>;
    readonly scanned: number;
}

type BrowserALRuntimeDeletionPolicy =
    | Readonly<{ kind: 'all'; }>
    | Readonly<{ kind: 'expired'; nowMs: number; }>;

export type BrowserALRuntimeCleanupResult = Readonly<{
    dbName: string;
    storeName: string;
    keyPrefixes: readonly string[];
    scanned: number;
    deleted: number;
}>;

export type DeleteExpiredBrowserALRuntimeEntriesOptions = Readonly<{
    nowMs?: number;
    keyPrefixes?: readonly string[];
}>;

let browserALRuntimeExpiryEvictionPromise: Promise<void> | undefined;

export async function deleteExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {}
): Promise<BrowserALRuntimeCleanupResult> {
    const nowMs = options.nowMs ?? Date.now();

    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
        deletionPolicy: { kind: 'expired', nowMs }
    });
}

export async function deleteExpiredBrowserALRuntimeEntriesForSession(
    sessionId: string,
    options: Omit<DeleteExpiredBrowserALRuntimeEntriesOptions, 'keyPrefixes'> = {}
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteExpiredBrowserALRuntimeEntries({
        ...options,
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId)
    });
}

export async function deleteBrowserALRuntimeEntriesForSession(
    sessionId: string
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
        deletionPolicy: { kind: 'all' }
    });
}

export async function evictExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {}
): Promise<BrowserALRuntimeCleanupResult> {
    const result = await deleteExpiredBrowserALRuntimeEntries(options);
    if (result.deleted > 0) {
        console.log(`Evicted expired browser AL runtime rows: ${result.deleted}`);
    }

    return result;
}

export async function initBrowserALRuntimeExpiryEviction(
    intervalMs: number = BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS
): Promise<void> {
    if (!browserALRuntimeExpiryEvictionPromise) {
        const promise = tryRunInIntervals(
            async () => {
                await evictExpiredBrowserALRuntimeEntries();
            },
            intervalMs
        )
            .then(() => undefined)
            .catch((error) => {
                if (browserALRuntimeExpiryEvictionPromise === promise) {
                    browserALRuntimeExpiryEvictionPromise = undefined;
                }
                throw error;
            });
        browserALRuntimeExpiryEvictionPromise = promise;
    }

    return await browserALRuntimeExpiryEvictionPromise;
}

async function deleteBrowserALRuntimeEntriesMatching(
    options: Readonly<{
        keyPrefixes: readonly string[];
        deletionPolicy: BrowserALRuntimeDeletionPolicy;
    }>
): Promise<BrowserALRuntimeCleanupResult> {
    const keyPrefixes = [...new Set(options.keyPrefixes)].filter((prefix) => prefix.length > 0);
    const emptyResult = toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);

    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
        return emptyResult;
    }

    const db = await openIndexedDbWithStore(
        BROWSER_AL_RUNTIME_DB_NAME,
        {
            name: BROWSER_AL_RUNTIME_STORE_NAME,
            keyPath: 'key'
        }
    );

    try {
        const read = await readBrowserALRuntimeCleanup(db, keyPrefixes);
        const computed = computeBrowserALRuntimeCleanup(read, options.deletionPolicy);
        await writeBrowserALRuntimeCleanup(db, read.revision, computed);
        return toBrowserALRuntimeCleanupResult(keyPrefixes, computed.scanned, computed.deleteKeys.length);
    }
    finally {
        db.close();
    }
}

async function readBrowserALRuntimeCleanup(
    db: IDBDatabase,
    keyPrefixes: readonly string[]
): Promise<BrowserALRuntimeCleanupRead> {
    const transaction = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readonly');
    const store = transaction.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
    const rowsPromise = readBrowserALRuntimeCleanupRows(store, keyPrefixes);
    const revisionPromise = requestToPromise<unknown>(store.get(AL_ADMISSION_REVISION_KEY));
    const completed = transactionDone(transaction);
    const [rows, revisionValue] = await Promise.all([rowsPromise, revisionPromise]);
    await completed;
    return { rows, revision: decodeBrowserALRuntimeRevision(revisionValue) };
}

function readBrowserALRuntimeCleanupRows(
    store: IDBObjectStore,
    keyPrefixes: readonly string[]
): Promise<readonly Readonly<{ key: string; value: unknown; }>[]> {
    return new Promise((resolve, reject) => {
        const rows: Readonly<{ key: string; value: unknown; }>[] = [];
        const request = store.openCursor();
        request.onerror = () => reject(request.error ?? new Error('Browser AL runtime cleanup cursor failed'));
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor === null) {
                resolve(rows);
                return;
            }
            const key = cursor.primaryKey;
            if (typeof key !== 'string') {
                reject(new TypeError('Browser AL runtime cleanup row key must be a string'));
                return;
            }
            if (matchesAnyBrowserALRuntimePrefix(key, keyPrefixes)) {
                rows.push({ key, value: cursor.value });
            }
            cursor.continue();
        };
    });
}

function decodeBrowserALRuntimeRevision(value: unknown): number {
    if (value === undefined) {
        return 0;
    }
    const stored = decodeALAdmissionValue(value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionStoredValue);
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

function computeBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy
): BrowserALRuntimeCleanupComputed {
    const deleteKeys: string[] = [];
    for (const row of read.rows) {
        if (shouldDeleteBrowserALRuntimeEntry(row.key, row.value, deletionPolicy)) {
            deleteKeys.push(row.key);
        }
    }
    return {
        deleteKeys,
        revisionWrite: {
            key: AL_ADMISSION_REVISION_KEY,
            value: read.revision + 1,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        },
        scanned: read.rows.length
    };
}

async function writeBrowserALRuntimeCleanup(
    db: IDBDatabase,
    expectedRevision: number,
    computed: BrowserALRuntimeCleanupComputed
): Promise<void> {
    if (computed.deleteKeys.length === 0) {
        return;
    }
    const committed = await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(BROWSER_AL_RUNTIME_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(BROWSER_AL_RUNTIME_STORE_NAME);
        const revisionRequest = store.get(AL_ADMISSION_REVISION_KEY);
        let conflict = false;

        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => {
            if (conflict) {
                resolve(false);
                return;
            }
            reject(transaction.error ?? new Error('Browser AL runtime cleanup aborted'));
        };
        transaction.onerror = () => {
            if (!conflict) {
                reject(transaction.error ?? new Error('Browser AL runtime cleanup failed'));
            }
        };
        revisionRequest.onerror = () =>
            reject(revisionRequest.error ?? new Error('Browser AL runtime cleanup revision read failed'));
        revisionRequest.onsuccess = () => {
            const storedRevision = revisionRequest.result as { readonly value?: unknown; } | undefined;
            const actualRevision = storedRevision?.value ?? 0;
            if (actualRevision !== expectedRevision) {
                conflict = true;
                transaction.abort();
                return;
            }
            for (const key of computed.deleteKeys) {
                store.delete(key);
            }
            store.put(computed.revisionWrite);
        };
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('Browser AL runtime cleanup conflicted');
    }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Browser AL runtime cleanup request failed'));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser AL runtime cleanup read aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('Browser AL runtime cleanup read failed'));
    });
}

function toBrowserALRuntimeCleanupResult(
    keyPrefixes: readonly string[],
    scanned: number,
    deleted: number
): BrowserALRuntimeCleanupResult {
    return {
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        keyPrefixes,
        scanned,
        deleted
    };
}

function matchesAnyBrowserALRuntimePrefix(
    key: string,
    keyPrefixes: readonly string[]
): boolean {
    for (const prefix of keyPrefixes) {
        if (key.startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

function shouldDeleteBrowserALRuntimeEntry(
    key: string,
    value: unknown,
    policy: BrowserALRuntimeDeletionPolicy
): boolean {
    if (policy.kind === 'all') {
        return true;
    }
    if (value === null || typeof value !== 'object') {
        throw new ALAdmissionCorruptionError(key, new TypeError('Browser AL runtime cleanup row must be an object'));
    }
    const expireAtTimestamp = (value as { readonly expireAtTimestamp?: unknown; }).expireAtTimestamp;
    if (
        typeof expireAtTimestamp !== 'number' ||
        !Number.isSafeInteger(expireAtTimestamp) ||
        expireAtTimestamp < 0 ||
        Object.is(expireAtTimestamp, -0)
    ) {
        throw new ALAdmissionCorruptionError(
            key,
            new TypeError('Browser AL runtime cleanup expiry must be a non-negative safe integer')
        );
    }
    return expireAtTimestamp <= policy.nowMs;
}
