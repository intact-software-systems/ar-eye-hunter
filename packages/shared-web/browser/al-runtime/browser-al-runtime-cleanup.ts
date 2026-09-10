import { isIndexedDbALRuntimeStoreSupported } from '@shared/alm/al-runtime-stores.ts';
import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    AL_ADMISSION_SCHEMA_ID,
    createPassThroughALStorageResetSink,
    openIndexedDbAdmissionDatabase,
    type ALStorageResetEvent
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from '@shared/alm/write-indexed-db-admission-mutations.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type { StoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import type { ComputedIndexedDbQueueMutation } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import {
    computeBrowserALWorkCleanupMutations,
    readBrowserALWorkCleanupRows,
    writeBrowserALWorkExpiryCleanup
} from './browser-al-work-cleanup.ts';

import {
    BROWSER_AL_RUNTIME_DB_NAME,
    BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserSessionALRuntimeEntryKeyPrefixes,
    toBrowserSessionALRuntimeWorkNamespaces
} from './browser-al-runtime-identity.ts';

export const BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

export interface BrowserALRuntimeCleanupRead {
    readonly revision: number;
    readonly rows: readonly BrowserALRuntimeCleanupRow[];
    readonly workRows: readonly StoredResourceEntry[];
}

export interface BrowserALRuntimeCleanupRow {
    readonly key: string;
    readonly expireAtTimestamp: number;
    readonly writeToken: string;
}

export interface BrowserALRuntimeCleanupComputed {
    readonly mutations: readonly IndexedDbAdmissionMutation[];
    readonly queueMutations: readonly ComputedIndexedDbQueueMutation[];
    readonly revisionWrite: Readonly<{
        key: typeof AL_ADMISSION_REVISION_KEY;
        value: number;
        expireAtTimestamp: number;
    }>;
}

export type BrowserALRuntimeDeletionPolicy =
    | Readonly<{ kind: 'all'; }>
    | Readonly<{ kind: 'expired'; nowMs: number; }>;

export interface BrowserALRuntimeCleanupValidationIssue {
    readonly code:
        | 'duplicate-mutation'
        | 'missing-mutation'
        | 'revision-write-mismatch'
        | 'unexpected-mutation'
        | 'unexpected-mutation-kind'
        | 'write-token-mismatch'
        | 'queue-mutations-mismatch';
    readonly message: string;
}

export interface BrowserALRuntimeCleanupResult {
    readonly dbName: string;
    readonly storeName: string;
    readonly keyPrefixes: readonly string[];
    readonly scanned: number;
    readonly deleted: number;
}

export interface DeleteExpiredBrowserALRuntimeEntriesOptions {
    readonly nowMs?: number;
    readonly keyPrefixes?: readonly string[];
    readonly onStorageReset?: (event: ALStorageResetEvent) => void;
}

let browserALRuntimeExpiryEvictionPromise: Promise<void> | undefined;

export async function deleteExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions = {}
): Promise<BrowserALRuntimeCleanupResult> {
    const nowMs = options.nowMs ?? Date.now();

    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
        deletionPolicy: { kind: 'expired', nowMs },
        onStorageReset: options.onStorageReset
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
    sessionId: string,
    options: Readonly<{ onStorageReset?: (event: ALStorageResetEvent) => void; }> = {}
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesMatching({
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
        workNamespaces: toBrowserSessionALRuntimeWorkNamespaces(sessionId),
        canonicalScopes: [`browser-session:${sessionId}`],
        deletionPolicy: { kind: 'all' },
        onStorageReset: options.onStorageReset
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
    intervalMs: number = BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS,
    onStorageReset?: (event: ALStorageResetEvent) => void
): Promise<void> {
    if (!browserALRuntimeExpiryEvictionPromise) {
        const promise = tryRunInIntervals(
            async () => {
                await evictExpiredBrowserALRuntimeEntries({ onStorageReset });
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

function openBrowserALRuntimeDatabase(
    onStorageReset: ((event: ALStorageResetEvent) => void) | undefined
): Promise<IDBDatabase> {
    return openIndexedDbAdmissionDatabase({
        dbName: BROWSER_AL_RUNTIME_DB_NAME,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: onStorageReset ?? createPassThroughALStorageResetSink()
    });
}

async function deleteBrowserALRuntimeEntriesMatching(
    options: Readonly<{
        keyPrefixes: readonly string[];
        workNamespaces?: readonly string[];
        canonicalScopes?: readonly string[];
        deletionPolicy: BrowserALRuntimeDeletionPolicy;
        onStorageReset?: (event: ALStorageResetEvent) => void;
    }>
): Promise<BrowserALRuntimeCleanupResult> {
    const keyPrefixes = [...new Set(options.keyPrefixes)].filter((prefix) => prefix.length > 0);
    const workNamespaces = options.workNamespaces ?? [];
    const canonicalScopes = options.canonicalScopes ?? [];

    if (keyPrefixes.length === 0 || !isIndexedDbALRuntimeStoreSupported()) {
        return toBrowserALRuntimeCleanupResult(keyPrefixes, 0, 0);
    }

    const db = await openBrowserALRuntimeDatabase(options.onStorageReset);

    try {
        if (options.deletionPolicy.kind === 'expired') {
            await writeBrowserALWorkExpiryCleanup(db, options.deletionPolicy.nowMs);
        }
        const read = await readBrowserALRuntimeCleanup(db, {
            keyPrefixes,
            workNamespaces,
            canonicalScopes,
            policy: options.deletionPolicy
        });
        const computed = computeBrowserALRuntimeCleanup(read, options.deletionPolicy);
        const issues = validateBrowserALRuntimeCleanup(read, options.deletionPolicy, computed);
        if (issues.length > 0) {
            throw new TypeError(issues.map((issue) => issue.message).join('; '));
        }
        await writeBrowserALRuntimeCleanup(db, read.revision, computed);
        return toBrowserALRuntimeCleanupResult(
            keyPrefixes,
            read.rows.length + read.workRows.length,
            computed.mutations.length + computed.queueMutations.length
        );
    }
    finally {
        db.close();
    }
}

async function readBrowserALRuntimeCleanup(
    db: IDBDatabase,
    options: Readonly<{
        keyPrefixes: readonly string[];
        workNamespaces: readonly string[];
        canonicalScopes: readonly string[];
        policy: BrowserALRuntimeDeletionPolicy;
    }>
): Promise<BrowserALRuntimeCleanupRead> {
    const { keyPrefixes, workNamespaces, canonicalScopes, policy } = options;
    const readsExpiryIndex = policy.kind === 'expired' &&
        keyPrefixes.length === 1 &&
        keyPrefixes[0] === BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX;
    const snapshot = await readIndexedDbAdmissionSnapshot(
        db,
        BROWSER_AL_RUNTIME_STORE_NAME,
        readsExpiryIndex
            ? { kind: 'expired', maximumExpireAtTimestamp: policy.nowMs }
            : { kind: 'prefixes', prefixes: keyPrefixes }
    );
    return {
        revision: snapshot.revision,
        // The 'expired' policy hands AL work rows to writeBrowserALWorkExpiryCleanup instead.
        workRows: policy.kind === 'all'
            ? await readBrowserALWorkCleanupRows(db, { namespacePrefixes: workNamespaces, canonicalScopes })
            : [],
        rows: snapshot.stored
            .filter((stored) =>
                stored.key !== AL_ADMISSION_REVISION_KEY &&
                matchesAnyBrowserALRuntimePrefix(stored.key, keyPrefixes)
            )
            .map((stored) => ({
                key: stored.key,
                expireAtTimestamp: stored.expireAtTimestamp,
                writeToken: stored.writeToken
            }))
    };
}

function computeBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy
): BrowserALRuntimeCleanupComputed {
    return {
        queueMutations: computeBrowserALWorkCleanupMutations(read.workRows, deletionPolicy),
        mutations: read.rows
            .filter((row) => (deletionPolicy.kind === 'all' ||
                row.expireAtTimestamp <= deletionPolicy.nowMs)
            )
            .map((row): IndexedDbAdmissionMutation => ({
                kind: 'remove-if-write-token',
                key: row.key,
                expectedWriteToken: row.writeToken
            })),
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(read.revision)
    };
}

export function validateBrowserALRuntimeCleanup(
    read: BrowserALRuntimeCleanupRead,
    deletionPolicy: BrowserALRuntimeDeletionPolicy,
    computed: BrowserALRuntimeCleanupComputed
): readonly BrowserALRuntimeCleanupValidationIssue[] {
    const eligibleRows = read.rows.filter((row) =>
        deletionPolicy.kind === 'all' || row.expireAtTimestamp <= deletionPolicy.nowMs
    );
    return [
        ...validateBrowserALRuntimeCleanupMutations(eligibleRows, computed.mutations),
        ...(!jsonEquals(
                computed.queueMutations,
                computeBrowserALWorkCleanupMutations(read.workRows, deletionPolicy)
            )
            ? [{
                code: 'queue-mutations-mismatch' as const,
                message: 'Browser AL work cleanup mutations differ from the owned queue observations'
            }]
            : []),
        ...validateBrowserALRuntimeCleanupRevision(read.revision, computed.revisionWrite)
    ];
}

function validateBrowserALRuntimeCleanupMutations(
    eligibleRows: readonly BrowserALRuntimeCleanupRow[],
    mutations: readonly IndexedDbAdmissionMutation[]
): readonly BrowserALRuntimeCleanupValidationIssue[] {
    const issues: BrowserALRuntimeCleanupValidationIssue[] = [];
    const eligibleRowsByKey = new Map(eligibleRows.map((row) => [row.key, row]));
    const guardedMutationKeys = new Set<string>();

    for (const mutation of mutations) {
        const key = mutation.kind === 'set' ? mutation.stored.key : mutation.key;
        issues.push(...validateBrowserALRuntimeCleanupMutation(
            mutation,
            eligibleRowsByKey.get(key),
            guardedMutationKeys.has(key)
        ));
        if (mutation.kind === 'remove-if-write-token') {
            guardedMutationKeys.add(key);
        }
    }

    for (const eligibleRow of eligibleRows) {
        if (!guardedMutationKeys.has(eligibleRow.key)) {
            issues.push({
                code: 'missing-mutation',
                message: `Browser AL runtime cleanup is missing mutation "${eligibleRow.key}"`
            });
        }
    }

    return issues;
}

function validateBrowserALRuntimeCleanupMutation(
    mutation: IndexedDbAdmissionMutation,
    eligibleRow: BrowserALRuntimeCleanupRow | undefined,
    duplicate: boolean
): readonly BrowserALRuntimeCleanupValidationIssue[] {
    const key = mutation.kind === 'set' ? mutation.stored.key : mutation.key;
    if (mutation.kind !== 'remove-if-write-token') {
        return [{
            code: 'unexpected-mutation-kind',
            message: `Browser AL runtime cleanup mutation for "${key}" is not guarded`
        }];
    }
    const issues: BrowserALRuntimeCleanupValidationIssue[] = [];
    if (duplicate) {
        issues.push({
            code: 'duplicate-mutation',
            message: `Browser AL runtime cleanup contains duplicate mutation "${key}"`
        });
    }
    if (!eligibleRow) {
        issues.push({
            code: 'unexpected-mutation',
            message: `Browser AL runtime cleanup mutation "${key}" is not eligible`
        });
    }
    else if (mutation.expectedWriteToken !== eligibleRow.writeToken) {
        issues.push({
            code: 'write-token-mismatch',
            message: `Browser AL runtime cleanup mutation "${key}" has the wrong write token`
        });
    }
    return issues;
}

function validateBrowserALRuntimeCleanupRevision(
    expectedRevision: number,
    revisionWrite: BrowserALRuntimeCleanupComputed['revisionWrite']
): readonly BrowserALRuntimeCleanupValidationIssue[] {
    if (
        revisionWrite.key !== AL_ADMISSION_REVISION_KEY ||
        revisionWrite.value !== expectedRevision + 1 ||
        revisionWrite.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP
    ) {
        return [{
            code: 'revision-write-mismatch',
            message: 'Browser AL runtime cleanup revision write is invalid'
        }];
    }

    return [];
}

async function writeBrowserALRuntimeCleanup(
    db: IDBDatabase,
    expectedRevision: number,
    computed: BrowserALRuntimeCleanupComputed
): Promise<void> {
    if (computed.mutations.length === 0 && computed.queueMutations.length === 0) {
        return;
    }
    const committed = await writeIndexedDbAdmissionMutations({
        queueMutations: computed.queueMutations,
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
