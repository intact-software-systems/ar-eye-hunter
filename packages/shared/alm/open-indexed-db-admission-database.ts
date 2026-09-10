import {
    IndexedDbSchemaMismatchError,
    openIndexedDbWithStores,
    type IndexedDbStoreDefinition
} from '../persistence/open-indexed-db.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { toIndexedDbQueueStoreDefinition } from '../queuebox/indexed-db-queue-box-store.ts';
import { decodeALAdmissionStoredValue } from './al-admission-backend.ts';
import { decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber, decodeALAdmissionString } from './al-admission-value-validation.ts';

export const AL_ADMISSION_WORK_STORE_NAME = 'alm-work';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';
export const AL_ADMISSION_SCHEMA_KEY = '__rallar_al_schema__';
export const AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-09-f2';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

const INDEXED_DB_DELETE_BLOCKED_TIMEOUT_MS = 5_000;

const INITIAL_INDEXED_DB_ADMISSION_REVISION = {
    key: AL_ADMISSION_REVISION_KEY,
    value: 0,
    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
} as const;

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
export class ALStorageResetBlockedError extends Error {
    constructor(dbName: string) {
        super(`IndexedDB database "${dbName}" delete is blocked by an open connection`);
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
 * Opens the admission database, resetting it once (delete and recreate) when its stores or its
 * schema identity do not match. A mismatch that persists after that single reset is a storage
 * invariant failure, not an expected outcome, so it throws.
 */
export async function openIndexedDbAdmissionDatabase(
    input: OpenIndexedDbAdmissionDatabaseInput
): Promise<IDBDatabase> {
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

export function decodeIndexedDbAdmissionRevision(value: IDBRequest['result']): number {
    if (value === undefined) {
        throw new TypeError('IndexedDB admission revision row is required');
    }
    const stored = decodeALAdmissionValue(
        value,
        AL_ADMISSION_REVISION_KEY,
        decodeALAdmissionStoredValue
    );
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}

async function openOrReset(
    input: OpenIndexedDbAdmissionDatabaseInput,
    attempt: OpenOrResetAttempt
): Promise<OpenOrResetResult> {
    let db: IDBDatabase;
    try {
        db = await openIndexedDbWithStores(
            input.dbName,
            toAdmissionStoreDefinitions(input.storeName, input.schemaId)
        );
    }
    catch (error) {
        if (attempt === 'after-reset' || !isIndexedDbSchemaMismatch(error)) {
            throw error;
        }
        return await toStoreSchemaMismatchReset(input);
    }
    return await toSchemaIdMismatchReset(input, attempt, db);
}

function isIndexedDbSchemaMismatch(error: unknown): error is IndexedDbSchemaMismatchError {
    return error instanceof IndexedDbSchemaMismatchError;
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
            initialRecords: [INITIAL_INDEXED_DB_ADMISSION_REVISION, toInitialSchemaRecord(schemaId)]
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

async function readStoredSchemaId(db: IDBDatabase, storeName: string): Promise<string | undefined> {
    const value = await new Promise<IDBRequest['result']>((resolve, reject) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(AL_ADMISSION_SCHEMA_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB schema read failed'));
    });
    return decodeIndexedDbAdmissionSchemaId(value);
}

async function deleteIndexedDbDatabase(dbName: string): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        let blockedTimer: ReturnType<typeof setTimeout> | undefined;
        request.onblocked = () => {
            blockedTimer = setTimeout(
                () => reject(new ALStorageResetBlockedError(dbName)),
                INDEXED_DB_DELETE_BLOCKED_TIMEOUT_MS
            );
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
