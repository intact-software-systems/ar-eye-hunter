import { decodeALAdmissionValue } from '@shared/alm/al-admission-decoder.ts';
import { decodeALAdmissionNumber } from '@shared/alm/al-admission-value-validation.ts';
import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    computeIndexedDbAdmissionRevisionWrite,
    openIndexedDbAdmissionDatabase,
    readIndexedDbAdmissionSnapshot,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from '@shared/alm/indexed-db-admission-storage.ts';
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
    readonly rows: readonly BrowserALRuntimeCleanupRow[];
}

interface BrowserALRuntimeCleanupStoredRow {
    readonly key: string;
    readonly expireAtTimestamp: unknown;
    readonly writeToken: unknown;
}

interface BrowserALRuntimeCleanupRow {
    readonly key: string;
    readonly expireAtTimestamp: number | null;
    readonly writeToken: string | null;
}

interface BrowserALRuntimeCleanupComputed {
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly revisionWrite: Readonly<{
        key: typeof AL_ADMISSION_REVISION_KEY;
        value: number;
        expireAtTimestamp: number;
    }>;
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

    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
        return toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);
    }

    const db = await openIndexedDbAdmissionDatabase(
        BROWSER_AL_RUNTIME_DB_NAME,
        BROWSER_AL_RUNTIME_STORE_NAME
    );

    try {
        const read = await readBrowserALRuntimeCleanup(db, keyPrefixes, options.deletionPolicy);
        const computed = computeBrowserALRuntimeCleanup(read, options.deletionPolicy);
        assertBrowserALRuntimeCleanup(read, options.deletionPolicy, computed);
        await writeBrowserALRuntimeCleanup(db, read.revision, computed);
        return toBrowserALRuntimeCleanupResult(
            keyPrefixes,
            read.rows.length,
            computed.mutations.length
        );
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
    const readsExpiryIndex = policy.kind === 'expired' &&
        keyPrefixes.length === 1 &&
        keyPrefixes[0] === BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX;
    const snapshot = await readIndexedDbAdmissionSnapshot(
        db,
        BROWSER_AL_RUNTIME_STORE_NAME,
        readsExpiryIndex
            ? { kind: 'expired', maximumExpireAtTimestamp: policy.nowMs }
            : { kind: 'prefixes', prefixes: keyPrefixes },
        readBrowserALRuntimeCleanupStoredRow
    );
    return {
        revision: snapshot.revision,
        rows: snapshot.stored
            .filter((stored) =>
                stored.key !== AL_ADMISSION_REVISION_KEY &&
                matchesAnyBrowserALRuntimePrefix(stored.key, keyPrefixes)
            )
            .map((stored) => ({
                key: stored.key,
                expireAtTimestamp: policy.kind === 'all'
                    ? null
                    : decodeBrowserALRuntimeExpiry(stored),
                writeToken: decodeBrowserALRuntimeWriteToken(stored)
            }))
    };
}

function readBrowserALRuntimeCleanupStoredRow(
    value: unknown,
    key: string
): BrowserALRuntimeCleanupStoredRow {
    return {
        key,
        expireAtTimestamp: Reflect.get(value as object, 'expireAtTimestamp'),
        writeToken: Reflect.get(value as object, 'writeToken')
    };
}

function decodeBrowserALRuntimeExpiry(row: BrowserALRuntimeCleanupStoredRow): number {
    return decodeALAdmissionValue(row.expireAtTimestamp, row.key, decodeALAdmissionNumber);
}

function decodeBrowserALRuntimeWriteToken(row: BrowserALRuntimeCleanupStoredRow): string | null {
    if (row.writeToken === undefined) {
        return null;
    }
    return decodeALAdmissionValue(row.writeToken, row.key, (value) => {
        if (typeof value !== 'string' || value.length === 0) {
            throw new TypeError('Browser AL runtime write token must be a non-empty string');
        }
        return value;
    });
}

function computeBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy
): BrowserALRuntimeCleanupComputed {
    return {
        mutations: read.rows
            .filter((row) =>
                deletionPolicy.kind === 'all' ||
                (row.expireAtTimestamp !== null && row.expireAtTimestamp <= deletionPolicy.nowMs)
            )
            .map((row): IndexedDbAdmissionMutation =>
                row.writeToken === null
                    ? { kind: 'remove', key: row.key }
                    : {
                        kind: 'remove-if-write-token',
                        key: row.key,
                        expectedWriteToken: row.writeToken
                    }
            ),
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(read.revision)
    };
}

function assertBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy,
    computed: BrowserALRuntimeCleanupComputed
): void {
    const expected = computeBrowserALRuntimeCleanup(read, deletionPolicy);
    if (JSON.stringify(computed) !== JSON.stringify(expected)) {
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
    return keyPrefixes.some((prefix) => key.startsWith(prefix));
}
