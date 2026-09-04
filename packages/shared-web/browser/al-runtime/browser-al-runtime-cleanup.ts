import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    computeIndexedDbAdmissionRevisionWrite,
    listIndexedDbAdmissionSnapshot,
    readIndexedDbAdmissionKeySnapshot,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from '@shared/alm/indexed-db-admission-storage.ts';
import { openIndexedDbWithStore } from '@shared/persistence/openIndexedDb.ts';
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
    readonly rows: readonly Readonly<{ key: string; expireAtTimestamp: number | null; }>[];
}

interface BrowserALRuntimeCleanupComputed {
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly revisionWrite: Readonly<{
        key: typeof AL_ADMISSION_REVISION_KEY;
        value: number;
        expireAtTimestamp: number;
    }>;
    readonly scanned: number;
    readonly deleted: number;
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
        const read = await readBrowserALRuntimeCleanup(db, keyPrefixes, options.deletionPolicy);
        const computed = computeBrowserALRuntimeCleanup(read, options.deletionPolicy);
        validateBrowserALRuntimeCleanup(read, options.deletionPolicy, computed);
        await writeBrowserALRuntimeCleanup(db, read.revision, computed);
        return toBrowserALRuntimeCleanupResult(keyPrefixes, computed.scanned, computed.deleted);
    }
    finally {
        db.close();
    }
}

async function readBrowserALRuntimeCleanup(
    db: IDBDatabase,
    keyPrefixes: readonly string[],
    policy: BrowserALRuntimeDeletionPolicy
): Promise<BrowserALRuntimeCleanupRead> {
    if (policy.kind === 'all') {
        const snapshot = await readIndexedDbAdmissionKeySnapshot(
            db,
            BROWSER_AL_RUNTIME_STORE_NAME,
            keyPrefixes
        );
        return {
            revision: snapshot.revision,
            rows: snapshot.keys.map((key) => ({ key, expireAtTimestamp: null }))
        };
    }
    const snapshot = await listIndexedDbAdmissionSnapshot(db, BROWSER_AL_RUNTIME_STORE_NAME, '');
    return {
        revision: snapshot.revision,
        rows: snapshot.stored
            .filter((stored) =>
                stored.key !== AL_ADMISSION_REVISION_KEY &&
                matchesAnyBrowserALRuntimePrefix(stored.key, keyPrefixes)
            )
            .map((stored) => ({ key: stored.key, expireAtTimestamp: stored.expireAtTimestamp }))
    };
}

function computeBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy
): BrowserALRuntimeCleanupComputed {
    const deleteKeys: string[] = [];
    for (const row of read.rows) {
        if (
            deletionPolicy.kind === 'all' ||
            (row.expireAtTimestamp !== null && row.expireAtTimestamp <= deletionPolicy.nowMs)
        ) {
            deleteKeys.push(row.key);
        }
    }
    return {
        mutations: deleteKeys.map((key) => ({ kind: 'remove', key })),
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(read.revision),
        scanned: read.rows.length,
        deleted: deleteKeys.length
    };
}

function validateBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy,
    computed: BrowserALRuntimeCleanupComputed
): void {
    const expected = computeBrowserALRuntimeCleanup(read, deletionPolicy);
    if (
        computed.scanned !== expected.scanned ||
        computed.deleted !== expected.deleted ||
        computed.revisionWrite.key !== expected.revisionWrite.key ||
        computed.revisionWrite.value !== expected.revisionWrite.value ||
        computed.revisionWrite.expireAtTimestamp !== expected.revisionWrite.expireAtTimestamp ||
        computed.mutations.length !== expected.mutations.length ||
        computed.mutations.some((mutation, index) => {
            const expectedMutation = expected.mutations[index];
            return mutation.kind !== 'remove' ||
                expectedMutation?.kind !== 'remove' ||
                mutation.key !== expectedMutation.key;
        })
    ) {
        throw new TypeError('Browser AL runtime cleanup differs from its canonical computation');
    }
}

async function writeBrowserALRuntimeCleanup(
    db: IDBDatabase,
    expectedRevision: number,
    computed: BrowserALRuntimeCleanupComputed
): Promise<void> {
    if (computed.mutations.length === 0) {
        return;
    }
    const committed = await writeIndexedDbAdmissionMutations({
        db,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        expectedRevision,
        mutations: computed.mutations,
        revisionWrite: computed.revisionWrite
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('Browser AL runtime cleanup conflicted');
    }
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
