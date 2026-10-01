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

export interface OpenIndexedDbAdmissionDatabaseInput {
    readonly dbName: string;
    readonly storeName: string;
    readonly schemaId: string;
    readonly onStorageReset: (event: ALStorageResetEvent) => void;
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
    | Readonly<{ kind: 'open'; db: IDBDatabase; }>
    | Readonly<{ kind: 'reset'; event: ALStorageResetEvent; }>;

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
    if (typeof indexedDB === 'undefined') {
        throw new ALStorageUnavailableError({
            cause: 'missing',
            detail: 'IndexedDB is not available in this environment'
        });
    }
    const first = await openOrReset(input, undefined);
    if (first.kind === 'open') {
        return first.db;
    }
    input.onStorageReset(first.event);
    const second = await openOrReset(input, 'after-reset');
    if (second.kind === 'open') {
        return second.db;
    }
    throw new Error(`ALM storage ${input.dbName} still mismatches after reset`);
}

async function openOrReset(
    input: OpenIndexedDbAdmissionDatabaseInput,
    attempt: OpenOrResetAttempt
): Promise<OpenOrResetResult> {
    const opened = await openAdmissionStores(input);
    if (opened.schemaIssues.length === 0) {
        return await toSchemaIdMismatchReset(input, attempt, opened.db);
    }
    opened.db.close();
    if (attempt === 'after-reset') {
        throw new Error(`ALM storage ${input.dbName} schema mismatch: ${opened.schemaIssues[0]}`);
    }
    return await toStoreSchemaMismatchReset(input);
}

/** Only the open request's own failure is `open-failed`; what the opened stores hold is checked after it. */
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
    db: IDBDatabase
): Promise<OpenOrResetResult> {
    const storedSchemaId = await readStoredSchemaId(db, input.storeName);
    if (storedSchemaId === input.schemaId) {
        return { kind: 'open', db };
    }
    db.close();
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
