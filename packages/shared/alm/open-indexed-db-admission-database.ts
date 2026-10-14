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
export const AL_ADMISSION_SCHEMA_ID = 'rallar-alm-2026-10-roster-fence';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

/**
 * A notified reset may describe an independent external schema reset. This opener only reports
 * observed other-context recreation; it never performs either schema-mismatch reset.
 */
export interface ALStorageResetEvent {
    readonly dbName: string;
    readonly previousSchemaId: string | undefined;
    readonly schemaId: string;
    readonly reason: 'schema-id-mismatch' | 'store-schema-mismatch' | 'other-context';
}

/** The opener invokes this only after observing external recreation; callback failure closes its acquired handle. */
export type ALStorageResetSink = (event: ALStorageResetEvent) => void;

/**
 * What one open found. `created` is a first creation in this document; a creation of a database this
 * document opened before is another context's reset after a `versionchange` closed it here, and an
 * eviction without one. A store of a connect reports what another store of that connect found
 * (`ALStorageConnectOpenings`).
 */
export type ALStorageOpening =
    | Readonly<{ kind: 'existing'; }>
    | Readonly<{ kind: 'created'; }>
    | Readonly<{ kind: 'reset'; reason: ALStorageResetEvent['reason']; }>
    | Readonly<{ kind: 'evicted'; }>;

export interface OpenedIndexedDbAdmissionStorage {
    readonly db: IDBDatabase;
    readonly opening: ALStorageOpening;
}

export interface OpenIndexedDbAdmissionDatabaseInput {
    readonly dbName: string;
    readonly storeName: string;
    readonly schemaId: string;
    readonly onStorageReset: ALStorageResetSink;
    /** Absent for an open that serves no store of a connect, such as a cleanup or a standalone pair. */
    readonly connectOpening?: ALStorageConnectStoreOpening;
}

export class ALStorageSchemaMismatchError extends Error {
    constructor(dbName: string, reason: string) {
        super(`ALM storage "${dbName}" does not match its required schema: ${reason}`);
        this.name = 'ALStorageSchemaMismatchError';
    }
}

export class ALStorageSchemaIdentityError extends Error {
    constructor(dbName: string, cause: Error) {
        super(`ALM storage "${dbName}" schema identity could not be read`, { cause });
        this.name = 'ALStorageSchemaIdentityError';
    }
}

/**
 * What this document saw of each admission database: that it opened it, and whether a `versionchange` closed it since.
 * It tells another context's reset from an eviction; what a connect found stays with that connect.
 */
type DocumentAdmissionDatabase = 'opened' | 'versionchange';

const DOCUMENT_ADMISSION_DATABASES = new LatestRepository<string, DocumentAdmissionDatabase>();

export function createPassThroughALStorageResetSink(): ALStorageResetSink {
    return () => {};
}

/**
 * The owners that keep memory of one store pair's rows, told when its database was deleted and
 * recreated so they forget it. The pair's composition notifies; each owner adds and removes itself.
 */
export class ALStorageResetListeners {
    private readonly listeners = new Set<ALStorageResetSink>();

    /** Returns the removal of this listener, for its owner's dispose. */
    add(listener: ALStorageResetSink): () => void {
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

/** Creates an absent database; existing stores and identity must match without any rewrite. */
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
    const opened = await openAdmissionStores(input);
    try {
        if (opened.schemaIssues.length > 0) {
            throw new ALStorageSchemaMismatchError(input.dbName, opened.schemaIssues.join('; '));
        }
        const schemaId = await readStoredSchemaId(opened.db, input.storeName);
        if (schemaId !== input.schemaId) {
            throw new ALStorageSchemaMismatchError(input.dbName, 'schema identity differs or is missing');
        }
        const opening = toALStorageOpening(opened.created, seen);
        if (opening.kind === 'reset') {
            input.onStorageReset({
                dbName: input.dbName,
                previousSchemaId: undefined,
                schemaId: input.schemaId,
                reason: 'other-context'
            });
        }
        return initAdmissionStorageOpening(input, opened.db, opening);
    }
    catch (error) {
        opened.db.close();
        throw error;
    }
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

async function readStoredSchemaId(db: IDBDatabase, storeName: string): Promise<string | undefined> {
    try {
        const value = await readIndexedDbRequest(
            db.transaction(storeName, 'readonly').objectStore(storeName).get(AL_ADMISSION_SCHEMA_KEY)
        );
        return decodeIndexedDbAdmissionSchemaId(value);
    }
    catch (error) {
        throw new ALStorageSchemaIdentityError(db.name, toError(error));
    }
}
