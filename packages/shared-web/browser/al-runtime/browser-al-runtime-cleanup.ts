import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { EMPTY_INDEXED_DB_ADMISSION_FENCE } from '@shared/alm/indexed-db-admission-fence.ts';
import {
    AL_ADMISSION_SCHEMA_ID,
    openIndexedDbAdmissionDatabase
} from '@shared/alm/open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from '@shared/alm/read-indexed-db-admission-snapshot.ts';
import { toALStorageResetSink, type ALStorageEventSink } from '@shared/alm/storage/al-storage-event.ts';
import { readALWorkRowsInRanges } from '@shared/alm/storage/read-al-work-rows-in-ranges.ts';
import {
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from '@shared/alm/write-indexed-db-admission-mutations.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import type { StoredResourceEntry } from '@shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import type { ComputedIndexedDbQueueMutation } from '@shared/queuebox/indexed-db-queue-box-entry.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { tryRunInIntervals } from '@shared/resilience/TryWith.ts';
import {
    computeBrowserALWorkCleanupMutations,
    writeBrowserALWorkExpiryCleanup
} from './browser-al-work-cleanup.ts';

import {
    toBrowserRtcOverlayALCheckpointRuntimeStoreId,
    toBrowserWsClientALCheckpointRuntimeStoreId
} from './browser-al-checkpoint-store-ids.ts';
import {
    BROWSER_AL_RUNTIME_DB_NAME_PREFIX,
    BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX,
    BROWSER_AL_RUNTIME_STORE_NAME,
    toBrowserALRuntimeDbName,
    toBrowserSessionALRuntimeEntryKeyPrefixes,
    toBrowserSessionALRuntimeWorkNamespaces
} from './browser-al-runtime-identity.ts';

export const BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS = 60_000;

export interface BrowserALRuntimeCleanupRead {
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
}

export type BrowserALRuntimeDeletionPolicy =
    | Readonly<{ kind: 'all'; }>
    | Readonly<{ kind: 'expired'; nowMs: number; }>;

export interface BrowserALRuntimeCleanupValidationIssue {
    readonly code:
        | 'duplicate-mutation'
        | 'missing-mutation'
        | 'unexpected-mutation'
        | 'unexpected-mutation-kind'
        | 'write-token-mismatch'
        | 'queue-mutations-mismatch';
    readonly message: string;
}

export interface BrowserALRuntimeCleanupResult {
    readonly dbNames: readonly string[];
    readonly storeName: string;
    readonly keyPrefixes: readonly string[];
    readonly scanned: number;
    readonly deleted: number;
}

export interface DeleteExpiredBrowserALRuntimeEntriesOptions {
    /** The one database swept where the browser cannot list its databases. */
    readonly currentScope: StateScope;
    readonly storage: ALStorageEventSink;
    readonly nowMs?: number;
    readonly keyPrefixes?: readonly string[];
}

export interface DeleteBrowserALRuntimeEntriesForSessionOptions {
    /** The one database purged where the browser cannot list its databases. */
    readonly currentScope: StateScope;
    readonly storage: ALStorageEventSink;
}

interface BrowserALRuntimeEntriesDeletion {
    readonly keyPrefixes: readonly string[];
    readonly workNamespaces: readonly string[];
    readonly canonicalScopes: readonly string[];
    readonly deletionPolicy: BrowserALRuntimeDeletionPolicy;
    readonly storage: ALStorageEventSink;
}

interface BrowserALRuntimeCleanupCounts {
    readonly scanned: number;
    readonly deleted: number;
}

export async function deleteExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesInEveryDatabase(options.currentScope, {
        keyPrefixes: options.keyPrefixes ?? [BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX],
        workNamespaces: [],
        canonicalScopes: [],
        deletionPolicy: { kind: 'expired', nowMs: options.nowMs ?? Date.now() },
        storage: options.storage
    });
}

/**
 * Deletes this session's expired KV admission-metadata rows only. AL work-row expiry is a side
 * effect of every call here, and it is store-wide in every scope's database (see
 * `writeBrowserALWorkExpiryCleanup`): other sessions' expired AL work rows are removed too, while
 * their live rows and their expired KV rows are untouched.
 */
export async function deleteExpiredBrowserALRuntimeEntriesForSession(
    sessionId: string,
    options: Omit<DeleteExpiredBrowserALRuntimeEntriesOptions, 'keyPrefixes'>
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteExpiredBrowserALRuntimeEntries({
        ...options,
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId)
    });
}

export async function deleteBrowserALRuntimeEntriesForSession(
    sessionId: string,
    options: DeleteBrowserALRuntimeEntriesForSessionOptions
): Promise<BrowserALRuntimeCleanupResult> {
    return await deleteBrowserALRuntimeEntriesInEveryDatabase(options.currentScope, {
        keyPrefixes: toBrowserSessionALRuntimeEntryKeyPrefixes(sessionId),
        workNamespaces: toBrowserSessionALRuntimeWorkNamespaces(sessionId),
        canonicalScopes: toBrowserSessionALCanonicalScopes(sessionId),
        deletionPolicy: { kind: 'all' },
        storage: options.storage
    });
}

/**
 * The durable pairs share the session's canonical scope; each checkpoint pair keeps its namespace as its
 * own, as two memory pairs never save one row.
 */
function toBrowserSessionALCanonicalScopes(sessionId: string): readonly string[] {
    return [
        `browser-session:${sessionId}`,
        `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${toBrowserWsClientALCheckpointRuntimeStoreId(sessionId)}`,
        `${BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX}${toBrowserRtcOverlayALCheckpointRuntimeStoreId(sessionId)}`
    ];
}

export async function evictExpiredBrowserALRuntimeEntries(
    options: DeleteExpiredBrowserALRuntimeEntriesOptions
): Promise<BrowserALRuntimeCleanupResult> {
    const result = await deleteExpiredBrowserALRuntimeEntries(options);
    if (result.deleted > 0) {
        console.log(`Evicted expired browser AL runtime rows: ${result.deleted}`);
    }

    return result;
}

export interface InitBrowserALRuntimeExpiryEvictionInput {
    /** The one database swept where the browser cannot list its databases. */
    readonly currentScope: StateScope;
    readonly storage: ALStorageEventSink;
    readonly intervalMs?: number;
}

let browserALRuntimeExpiryEvictionStarting: Promise<() => void> | undefined;
let browserALRuntimeExpiryEvictionGeneration = 0;

/**
 * Starts the recurring eviction of expired browser AL runtime rows, sharing one interval across
 * callers, and returns a `stop()` to silence it. Resolves once the first eviction cycle completes.
 */
export async function initBrowserALRuntimeExpiryEviction(
    input: InitBrowserALRuntimeExpiryEvictionInput
): Promise<() => void> {
    browserALRuntimeExpiryEvictionStarting ??= startBrowserALRuntimeExpiryEviction(input);
    return await browserALRuntimeExpiryEvictionStarting;
}

/**
 * `tryRunInIntervals` offers no external cancellation, so a stopped loop cannot clear its own
 * timer; `stop()` instead silences future ticks and clears the shared singleton so the next
 * `initBrowserALRuntimeExpiryEviction` call starts a fresh loop. The generation guard keeps a
 * stale `stop()` from clearing a newer instance's singleton entry.
 */
function startBrowserALRuntimeExpiryEviction(
    input: InitBrowserALRuntimeExpiryEvictionInput
): Promise<() => void> {
    const generation = ++browserALRuntimeExpiryEvictionGeneration;
    let stopped = false;
    const stop = (): void => {
        stopped = true;
        if (browserALRuntimeExpiryEvictionGeneration === generation) {
            browserALRuntimeExpiryEvictionStarting = undefined;
        }
    };
    return tryRunInIntervals(
        async () => {
            if (!stopped) {
                await evictExpiredBrowserALRuntimeEntries({
                    currentScope: input.currentScope,
                    storage: input.storage
                });
            }
        },
        input.intervalMs ?? BROWSER_AL_RUNTIME_EXPIRY_EVICTION_INTERVAL_MS
    )
        .then(() => stop)
        .catch((error) => {
            stop();
            throw error;
        });
}

/**
 * The prefix leaves the pre-scope database out, so it stays until the browser evicts it. A browser that
 * cannot list its databases, or fails to, still has the current scope's swept.
 */
async function readBrowserALRuntimeDbNames(currentScope: StateScope): Promise<readonly string[]> {
    if (typeof indexedDB.databases !== 'function') {
        return [toBrowserALRuntimeDbName(currentScope)];
    }
    try {
        const databases = await indexedDB.databases();
        return databases.flatMap(({ name }) => name?.startsWith(BROWSER_AL_RUNTIME_DB_NAME_PREFIX) ? [name] : []);
    }
    catch (error) {
        console.error('Failed to list the browser AL runtime databases:', toError(error));
        return [toBrowserALRuntimeDbName(currentScope)];
    }
}

/** A failing database does not keep the others from being swept; its failure is rethrown after them. */
async function deleteBrowserALRuntimeEntriesInEveryDatabase(
    currentScope: StateScope,
    deletion: BrowserALRuntimeEntriesDeletion
): Promise<BrowserALRuntimeCleanupResult> {
    const keyPrefixes = [...new Set(deletion.keyPrefixes)].filter((prefix) => prefix.length > 0);
    if (keyPrefixes.length === 0 || !IndexedDbStringPersistenceProvider.isSupported()) {
        return toBrowserALRuntimeCleanupResult([], keyPrefixes, []);
    }
    const dbNames = await readBrowserALRuntimeDbNames(currentScope);
    const counts: BrowserALRuntimeCleanupCounts[] = [];
    const failures: Error[] = [];
    for (const dbName of dbNames) {
        try {
            counts.push(await deleteBrowserALRuntimeEntriesInDatabase(dbName, { ...deletion, keyPrefixes }));
        }
        catch (error) {
            failures.push(toError(error));
        }
    }
    if (failures.length > 0) {
        throw failures[0];
    }
    return toBrowserALRuntimeCleanupResult(dbNames, keyPrefixes, counts);
}

/** The cleanup opens a whole database for no one store, so a reset it causes names the database. */
async function deleteBrowserALRuntimeEntriesInDatabase(
    dbName: string,
    deletion: BrowserALRuntimeEntriesDeletion
): Promise<BrowserALRuntimeCleanupCounts> {
    const db = await openIndexedDbAdmissionDatabase({
        dbName,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: toALStorageResetSink(deletion.storage, dbName)
    });
    try {
        if (deletion.deletionPolicy.kind === 'expired') {
            await writeBrowserALWorkExpiryCleanup(db, deletion.deletionPolicy.nowMs);
        }
        const read = await readBrowserALRuntimeCleanup(db, deletion);
        const computed = computeBrowserALRuntimeCleanup(read, deletion.deletionPolicy);
        const issues = validateBrowserALRuntimeCleanup(read, deletion.deletionPolicy, computed);
        if (issues.length > 0) {
            throw new TypeError(issues.map((issue) => issue.message).join('; '));
        }
        await writeBrowserALRuntimeCleanup(db, computed);
        return {
            scanned: read.rows.length + read.workRows.length,
            deleted: computed.mutations.length + computed.queueMutations.length
        };
    }
    finally {
        db.close();
    }
}

async function readBrowserALRuntimeCleanup(
    db: IDBDatabase,
    deletion: Omit<BrowserALRuntimeEntriesDeletion, 'storage'>
): Promise<BrowserALRuntimeCleanupRead> {
    const { keyPrefixes, workNamespaces, canonicalScopes, deletionPolicy: policy } = deletion;
    const readsExpiryIndex = policy.kind === 'expired' &&
        keyPrefixes.length === 1 &&
        keyPrefixes[0] === BROWSER_AL_RUNTIME_ENTRY_KEY_PREFIX;
    const rows = await readIndexedDbAdmissionSnapshot(
        db,
        BROWSER_AL_RUNTIME_STORE_NAME,
        readsExpiryIndex
            ? { kind: 'expired', maximumExpireAtTimestamp: policy.nowMs }
            : { kind: 'prefixes', prefixes: keyPrefixes }
    );
    return {
        // The 'expired' policy hands AL work rows to writeBrowserALWorkExpiryCleanup instead.
        workRows: policy.kind === 'all'
            ? await readALWorkRowsInRanges(db, { namespacePrefixes: workNamespaces, canonicalScopes })
            : [],
        rows: rows
            .filter((stored) => matchesAnyBrowserALRuntimePrefix(stored.key, keyPrefixes))
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
            }))
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
            : [])
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

/** Every deleted row is a write-token guarded removal, so the cleanup needs no fence of its own. */
async function writeBrowserALRuntimeCleanup(
    db: IDBDatabase,
    computed: BrowserALRuntimeCleanupComputed
): Promise<void> {
    if (computed.mutations.length === 0 && computed.queueMutations.length === 0) {
        return;
    }
    const committed = await writeIndexedDbAdmissionMutations({
        queueMutations: computed.queueMutations,
        db,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        fence: EMPTY_INDEXED_DB_ADMISSION_FENCE,
        mutations: computed.mutations
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('Browser AL runtime cleanup conflicted');
    }
}

function toBrowserALRuntimeCleanupResult(
    dbNames: readonly string[],
    keyPrefixes: readonly string[],
    counts: readonly BrowserALRuntimeCleanupCounts[]
): BrowserALRuntimeCleanupResult {
    return {
        dbNames,
        storeName: BROWSER_AL_RUNTIME_STORE_NAME,
        keyPrefixes,
        scanned: counts.reduce((total, count) => total + count.scanned, 0),
        deleted: counts.reduce((total, count) => total + count.deleted, 0)
    };
}

function matchesAnyBrowserALRuntimePrefix(
    key: string,
    keyPrefixes: readonly string[]
): boolean {
    return keyPrefixes.some((prefix) => key.startsWith(prefix));
}
