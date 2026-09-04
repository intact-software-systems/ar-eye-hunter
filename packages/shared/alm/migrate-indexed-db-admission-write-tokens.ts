import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import { ALAdmissionCorruptionError } from './al-admission-decoder.ts';
import {
    decodeIndexedDbAdmissionStoredRow,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';

export const AL_ADMISSION_WRITE_TOKEN_MIGRATION_KEY = '__rallar_al_admission_write_token_migration_v1__';

interface ComputedIndexedDbAdmissionWriteTokenMigration {
    readonly key: string;
    readonly writeToken: string;
}

export async function migrateIndexedDbAdmissionWriteTokens(
    db: IDBDatabase,
    storeName: string,
    revisionKey: string
): Promise<void> {
    if (await hasIndexedDbAdmissionWriteTokenMigrationMarker(db, storeName)) {
        return;
    }
    const computed = (await readTokenlessIndexedDbAdmissionRows(db, storeName, revisionKey))
        .map((row): ComputedIndexedDbAdmissionWriteTokenMigration => ({
            key: row.key,
            writeToken: crypto.randomUUID()
        }));
    for (const migration of computed) {
        await attachIndexedDbAdmissionWriteToken(db, storeName, migration);
    }
    await writeIndexedDbAdmissionWriteTokenMigrationMarker(db, storeName);
}

async function readTokenlessIndexedDbAdmissionRows(
    db: IDBDatabase,
    storeName: string,
    revisionKey: string
): Promise<readonly IndexedDbAdmissionStoredRow[]> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const values = await readIndexedDbRequest(transaction.objectStore(storeName).getAll());
    await completed;
    return values.flatMap((value): readonly IndexedDbAdmissionStoredRow[] => {
        const key = readStoredRowKey(value);
        if (key === revisionKey || key === AL_ADMISSION_WRITE_TOKEN_MIGRATION_KEY) {
            return [];
        }
        try {
            const row = decodeIndexedDbAdmissionStoredRow(value, key);
            return row.writeToken === undefined ? [row] : [];
        }
        catch (error) {
            if (error instanceof ALAdmissionCorruptionError) {
                return [];
            }
            throw error;
        }
    });
}

async function hasIndexedDbAdmissionWriteTokenMigrationMarker(
    db: IDBDatabase,
    storeName: string
): Promise<boolean> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const value = await readIndexedDbRequest(
        transaction.objectStore(storeName).get(AL_ADMISSION_WRITE_TOKEN_MIGRATION_KEY)
    );
    await completed;
    if (value === undefined) {
        return false;
    }
    const marker = decodeIndexedDbAdmissionStoredRow(
        value,
        AL_ADMISSION_WRITE_TOKEN_MIGRATION_KEY
    );
    if (marker.value !== 1) {
        throw new TypeError('IndexedDB admission write-token migration marker is invalid');
    }
    return true;
}

async function attachIndexedDbAdmissionWriteToken(
    db: IDBDatabase,
    storeName: string,
    computed: ComputedIndexedDbAdmissionWriteTokenMigration
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(storeName);
    const value = await readIndexedDbRequest(store.get(computed.key));
    if (value !== undefined) {
        const writeToken = readStoredRowWriteToken(value, computed.key);
        if (writeToken === undefined) {
            Object.defineProperty(value, 'writeToken', {
                value: computed.writeToken,
                configurable: true,
                enumerable: true,
                writable: true
            });
            store.put(value);
        }
    }
    await completed;
}

async function writeIndexedDbAdmissionWriteTokenMigrationMarker(
    db: IDBDatabase,
    storeName: string
): Promise<void> {
    const transaction = db.transaction(storeName, 'readwrite');
    const completed = waitForIndexedDbTransaction(transaction);
    transaction.objectStore(storeName).put(
        {
            key: AL_ADMISSION_WRITE_TOKEN_MIGRATION_KEY,
            value: 1,
            expireAtTimestamp: Number.MAX_SAFE_INTEGER,
            writeToken: 'migration-v1'
        } satisfies IndexedDbAdmissionStoredRow
    );
    await completed;
}

function readStoredRowKey(value: IDBRequest['result']): string {
    if (!value || typeof value !== 'object') {
        throw new ALAdmissionCorruptionError(
            '<unknown>',
            new TypeError('IndexedDB admission row must be a record')
        );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'key');
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw new ALAdmissionCorruptionError(
            '<unknown>',
            new TypeError('IndexedDB admission row key must be a string data field')
        );
    }
    return descriptor.value;
}

function readStoredRowWriteToken(
    value: IDBRequest['result'],
    expectedKey: string
): string | undefined {
    if (readStoredRowKey(value) !== expectedKey) {
        throw new ALAdmissionCorruptionError(
            expectedKey,
            new TypeError('IndexedDB admission row key differs from the requested key')
        );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, 'writeToken');
    if (descriptor === undefined) {
        return undefined;
    }
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') {
        throw new ALAdmissionCorruptionError(
            expectedKey,
            new TypeError('IndexedDB admission write token must be a string data field')
        );
    }
    return descriptor.value;
}
