import { LatestRepository } from '../cache/LatestRepository.ts';
import { readIndexedDbRequest } from '../persistence/indexed-db-request.ts';
import {
    openIndexedDbWithValidatedStores,
    type IndexedDbStoreDefinition,
    type OpenedIndexedDb
} from '../persistence/open-indexed-db.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { toIndexedDbQueueStoreDefinition } from '../queuebox/indexed-db-queue-box-store.ts';
import { toError } from '../resilience/to-error.ts';
import { decodeALAdmissionStoredValue } from './al-admission-backend.ts';
import { decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionString } from './al-admission-value-validation.ts';
import type { ALStorageConnectStoreOpening } from './storage/al-storage-connect-openings.ts';
import { ALStorageUnavailableError } from './storage/al-storage-unavailable.ts';

export const AL_ADMISSION_WORK_STORE_NAME = 'alm-work';

export const AL_ADMISSION_SCHEMA_KEY = '__rallar_al_schema__';
/** Bump on any persisted row-shape or index change: the store-schema check only counts indexes. */
export const AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-scoped-delivery';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

const INDEXED_DB_DELETE_BLOCKED_TIMEOUT_MS = 5_000;

/** Reported once the browser ALM database has been deleted and recreated because it no longer matched. */
export interface ALStorageResetEvent {
    readonly dbName: string;
    readonly previousSchemaId: string | undefined;
    readonly schemaId: string;
    readonly reason: 'schema-id-mismatch' | 'store-schema-mismatch';
}

/**
 * What one open found. `created` is a first creation in this document; a creation of a database this
 * document opened before is another context's reset after a `versionchange` closed it here, and an
 * eviction without one. A store of a connect reports what another store of that connect found
 * (`ALStorageConnectOpenings`).
 */
export type ALStorageOpening =
    | Readonly<{ kind: 'existing'; }>
    | Readonly<{ kind: 'created'; }>
    | Readonly<{ kind: 'reset'; reason: ALStorageResetEvent['reason'] | 'other-context'; }>
    | Readonly<{ kind: 'evicted'; }>;

export interface OpenedIndexedDbAdmissionStorage {
    readonly db: IDBDatabase;
    readonly opening: ALStorageOpening;
}

export interface OpenIndexedDbAdmissionDatabaseInput {
    readonly dbName: string;
    readonly storeName: string;
    readonly schemaId: string;
    readonly onStorageReset: (event: ALStorageResetEvent) => void;
    /** Absent for an open that serves no store of a connect, such as a cleanup or a standalone pair. */
    readonly connectOpening?: ALStorageConnectStoreOpening;
}

/** Thrown when `indexedDB.deleteDatabase` stays blocked by another open connection past its timeout. */
export class ALStorageResetBlockedError extends ALStorageUnavailableError {
    constructor(dbName: string) {
        super({
            cause: 'reset-blocked',
            detail: `IndexedDB database "${dbName}" delete is blocked by an open connection`
        });
        this.name = 'ALStorageResetBlockedError';
    }
}

type OpenOrResetAttempt = 'after-reset' | undefined;

type OpenOrResetResult =
    | Readonly<{ kind: 'open'; db: IDBDatabase; created: boolean; }>
    | Readonly<{ kind: 'reset'; event: ALStorageResetEvent; }>;

/**
 * What this document saw of each admission database: that it opened it, and whether a `versionchange` closed it since.
 * It tells another context's reset from an eviction; what a connect found stays with that connect.
 */
type DocumentAdmissionDatabase = 'opened' | 'versionchange';

const DOCUMENT_ADMISSION_DATABASES = new LatestRepository<string, DocumentAdmissionDatabase>();

export function createPassThroughALStorageResetSink(): (event: ALStorageResetEvent) => void {
    return () => {};
}

/**
 * The owners that keep memory of one store pair's rows, told when its database was deleted and
 * recreated so they forget it. The pair's composition notifies; each owner adds and removes itself.
 */
export class ALStorageResetListeners {
    private readonly listeners = new Set<(event: ALStorageResetEvent) => void>();

    /** Returns the removal of this listener, for its owner's dispose. */
    add(listener: (event: ALStorageResetEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    notify(event: ALStorageResetEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

/**
 * Opens the admission database, resetting it once (delete and recreate) when its stores or its
 * schema identity do not match. A mismatch that persists after that single reset is a storage
 * invariant failure, not an expected outcome, so it throws.
 */
export async function openIndexedDbAdmissionDatabase(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<IDBDatabase> {
    return (await openIndexedDbAdmissionStorage(input)).db;
}

export async function openIndexedDbAdmissionStorage(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<OpenedIndexedDbAdmissionStorage> {
    if (typeof indexedDB === 'undefined') {
        throw new ALStorageUnavailableError({
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        });
    }
    const seen = DOCUMENT_ADMISSION_DATABASES.read(input.dbName);
    const first = await openOrReset(input, undefined);
    if (first.kind === 'open') {
        return initAdmissionStorageOpening(input, first.db, toALStorageOpening(first.created, seen));
    }
    input.onStorageReset(first.event);
    const second = await openOrReset(input, 'after-reset');
    if (second.kind === 'open') {
        return initAdmissionStorageOpening(input, second.db, { kind: 'reset', reason: first.event.reason });
    }
    throw new Error(`ALM storage ${input.dbName} still mismatches after reset`);
}

function toALStorageOpening(created: boolean, seen: DocumentAdmissionDatabase | undefined): ALStorageOpening {
    if (!created) {
        return { kind: 'existing' };
    }
    if (seen === undefined) {
        return { kind: 'created' };
    }
    return seen === 'versionchange' ? { kind: 'reset', reason: 'other-context' } : { kind: 'evicted' };
}

/** Decided after the open: another store of the connect may have created or reset the database meanwhile. */
function initAdmissionStorageOpening(
    input: OpenIndexedDbAdmissionDatabaseInput,
    db: IDBDatabase,
    found: ALStorageOpening
): OpenedIndexedDbAdmissionStorage {
    DOCUMENT_ADMISSION_DATABASES.set(input.dbName, 'opened');
    db.addEventListener('versionchange', () => {
        DOCUMENT_ADMISSION_DATABASES.set(input.dbName, 'versionchange');
    });
    const connect = input.connectOpening;
    const opening = connect === undefined
        ? found
        : connect.openings.recordStoreOpening(input.dbName, connect.storeNamespace, found);
    return { db, opening };
}

async function openOrReset(
    input: OpenIndexedDbAdmissionDatabaseInput,
    attempt: OpenOrResetAttempt
): Promise<OpenOrResetResult> {
    const opened = await openAdmissionStores(input);
    if (opened.schemaIssues.length === 0) {
        return await toSchemaIdMismatchReset(input, attempt, opened);
    }
    opened.db.close();
    if (attempt === 'after-reset') {
        throw new Error(`ALM storage ${input.dbName} schema mismatch: ${opened.schemaIssues[0]}`);
    }
    return await toStoreSchemaMismatchReset(input);
}

/**
 * The open request's failure, a store that fails its name validation and a schema write that fails during
 * the upgrade are `open-failed`; what the opened stores hold is checked after it.
 */
async function openAdmissionStores(input: OpenIndexedDbAdmissionDatabaseInput): Promise<OpenedIndexedDb> {
    try {
        return await openIndexedDbWithValidatedStores(
            input.dbName,
            toAdmissionStoreDefinitions(input.storeName, input.schemaId)
        );
    }
    catch (error) {
        throw toOpenFailedError(input.dbName, toError(error));
    }
}

function toOpenFailedError(dbName: string, error: Error): ALStorageUnavailableError {
    return new ALStorageUnavailableError(
        { cause: 'open-failed', detail: `IndexedDB open of "${dbName}" failed: ${error.name}: ${error.message}` },
        { cause: error }
    );
}

async function toStoreSchemaMismatchReset(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<OpenOrResetResult> {
    await deleteIndexedDbDatabase(input.dbName);
    return {
        kind: 'reset',
        event: {
            dbName: input.dbName,
            previousSchemaId: undefined,
            schemaId: input.schemaId,
            reason: 'store-schema-mismatch'
        }
    };
}

async function toSchemaIdMismatchReset(
    input: OpenIndexedDbAdmissionDatabaseInput,
    attempt: OpenOrResetAttempt,
    opened: OpenedIndexedDb
): Promise<OpenOrResetResult> {
    const storedSchemaId = await readStoredSchemaId(opened.db, input.storeName);
    if (storedSchemaId === input.schemaId) {
        return { kind: 'open', db: opened.db, created: opened.created };
    }
    opened.db.close();
    if (attempt === 'after-reset') {
        throw new Error(`ALM schema id mismatch persisted in "${input.dbName}" after reset`);
    }
    await deleteIndexedDbDatabase(input.dbName);
    return {
        kind: 'reset',
        event: {
            dbName: input.dbName,
            previousSchemaId: storedSchemaId,
            schemaId: input.schemaId,
            reason: 'schema-id-mismatch'
        }
    };
}

function toAdmissionStoreDefinitions(
    storeName: string,
    schemaId: string
): readonly IndexedDbStoreDefinition<object>[] {
    return [
        {
            name: storeName,
            keyPath: 'key',
            indexes: [{
                name: AL_ADMISSION_EXPIRY_INDEX_NAME,
                keyPath: 'expireAtTimestamp'
            }],
            initialRecords: [toInitialSchemaRecord(schemaId)]
        },
        toIndexedDbQueueStoreDefinition(AL_ADMISSION_WORK_STORE_NAME)
    ];
}

interface IndexedDbAdmissionSchemaRecord {
    readonly key: typeof AL_ADMISSION_SCHEMA_KEY;
    readonly value: string;
    readonly expireAtTimestamp: number;
}

function toInitialSchemaRecord(schemaId: string): IndexedDbAdmissionSchemaRecord {
    return {
        key: AL_ADMISSION_SCHEMA_KEY,
        value: schemaId,
        expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
    };
}

function decodeIndexedDbAdmissionSchemaId(value: IDBRequest['result']): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const stored = decodeALAdmissionValue(value, AL_ADMISSION_SCHEMA_KEY, decodeALAdmissionStoredValue);
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_SCHEMA_KEY, decodeALAdmissionString);
}

/**
 * A row that cannot be read or decoded is a mismatch, not a hard failure (R54): the caller treats
 * `undefined` the same as "no schema record yet" and resets, so this never throws.
 */
async function readStoredSchemaId(db: IDBDatabase, storeName: string): Promise<string | undefined> {
    try {
        const value = await readIndexedDbRequest(
            db.transaction(storeName, 'readonly').objectStore(storeName).get(AL_ADMISSION_SCHEMA_KEY)
        );
        return decodeIndexedDbAdmissionSchemaId(value);
    }
    catch {
        return undefined;
    }
}

async function deleteIndexedDbDatabase(dbName: string): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        let blockedTimer: ReturnType<typeof setTimeout> | undefined;
        request.onblocked = () => {
            // IndexedDB offers no way to cancel a delete request: once armed, this timer can
            // still reject while the delete itself later succeeds against the blocking connection.
            if (blockedTimer === undefined) {
                blockedTimer = setTimeout(
                    () => reject(new ALStorageResetBlockedError(dbName)),
                    INDEXED_DB_DELETE_BLOCKED_TIMEOUT_MS
                );
            }
        };
        request.onsuccess = () => {
            clearTimeout(blockedTimer);
            resolve();
        };
        request.onerror = () => {
            clearTimeout(blockedTimer);
            reject(request.error ?? new Error(`IndexedDB delete failed for "${dbName}"`));
        };
    });
}
