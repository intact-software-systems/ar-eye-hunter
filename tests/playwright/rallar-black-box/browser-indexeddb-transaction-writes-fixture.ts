import { Temporal } from '@js-temporal/polyfill';

import {
    computeIndexedDbAdmissionRevisionWrite,
    openIndexedDbAdmissionDatabase,
    readIndexedDbAdmissionSnapshot,
    writeIndexedDbAdmissionMutations
} from '../../../packages/shared/alm/indexed-db-admission-storage.ts';
import {
    encodeStoredResourceEntry,
    type StoredResourceEntry
} from '../../../packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import {
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '../../../packages/shared/queuebox/ResourceEntry.ts';

const STORE_NAME = 'entries';

export interface IndexedDbTransactionWriteBrowserProbe {
    readonly databaseVersion: number;
    readonly fairnessIndexPresent: boolean;
    readonly migratedResource: string | undefined;
    readonly migratedRevision: number;
    readonly concurrentResults: readonly string[];
    readonly durableWinner: string | undefined;
    readonly admissionTokenMigrated: boolean;
    readonly guardedAdmissionBatchRolledBack: boolean;
}

export async function runIndexedDbTransactionWriteBrowserProbe(): Promise<IndexedDbTransactionWriteBrowserProbe> {
    const dbName = `playwright-indexeddb-queue-${crypto.randomUUID()}`;
    const legacyEntry = createQueueEntry('legacy', 'legacy-value');
    const encoded = encodeStoredResourceEntry(legacyEntry, 0);
    const { revision: _revision, ...legacyRow } = encoded;
    await createLegacyQueueDatabase(dbName, legacyRow);

    const firstQueue = new IndexedDbQueueBox({ dbName, storeName: STORE_NAME });
    const secondQueue = new IndexedDbQueueBox({ dbName, storeName: STORE_NAME });
    const [migrated, concurrentlyMigrated] = await Promise.all([
        firstQueue.getItem(legacyEntry.key),
        secondQueue.getItem(legacyEntry.key)
    ]);
    if (concurrentlyMigrated?.resource !== migrated?.resource) {
        throw new Error('Concurrent IndexedDB migration readers did not converge');
    }
    const firstCandidate = createQueueEntry('concurrent', 'first-value');
    const secondCandidate = createQueueEntry('concurrent', 'second-value');
    const concurrent = await Promise.all([
        firstQueue.enqueueIfAbsent(firstCandidate),
        secondQueue.enqueueIfAbsent(secondCandidate)
    ]);
    const durableWinner = await firstQueue.getItem(firstCandidate.key);
    const databaseState = await inspectQueueDatabase(dbName, legacyEntry.key);
    const admissionState = await runAdmissionStorageProbe();

    return {
        ...databaseState,
        ...admissionState,
        migratedResource: migrated?.resource,
        concurrentResults: concurrent.map((entry) => entry.resource),
        durableWinner: durableWinner?.resource
    };
}

async function runAdmissionStorageProbe(): Promise<
    Pick<IndexedDbTransactionWriteBrowserProbe, 'admissionTokenMigrated' | 'guardedAdmissionBatchRolledBack'>
> {
    const dbName = `playwright-indexeddb-admission-${crypto.randomUUID()}`;
    const storeName = 'admission';
    await createTokenlessAdmissionDatabase(dbName, storeName);
    const database = await openIndexedDbAdmissionDatabase(dbName, storeName);
    try {
        const migrated = await readIndexedDbAdmissionSnapshot(
            database,
            storeName,
            { kind: 'key', key: 'legacy' }
        );
        const committed = await writeIndexedDbAdmissionMutations({
            db: database,
            storeName,
            expectedRevision: migrated.revision,
            mutations: [
                {
                    kind: 'set',
                    stored: {
                        key: 'must-roll-back',
                        value: 'new',
                        expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                        writeToken: 'new-row-token'
                    }
                },
                {
                    kind: 'remove-if-write-token',
                    key: 'legacy',
                    expectedWriteToken: 'not-the-migrated-token'
                }
            ],
            revisionWrite: computeIndexedDbAdmissionRevisionWrite(migrated.revision)
        });
        const afterConflict = await readIndexedDbAdmissionSnapshot(
            database,
            storeName,
            { kind: 'prefixes', prefixes: ['legacy', 'must-roll-back'] }
        );
        return {
            admissionTokenMigrated: typeof migrated.stored[0]?.writeToken === 'string',
            guardedAdmissionBatchRolledBack: !committed &&
                afterConflict.stored.some((row) => row.key === 'legacy') &&
                !afterConflict.stored.some((row) => row.key === 'must-roll-back')
        };
    }
    finally {
        database.close();
    }
}

function createQueueEntry(resourceId: string, resource: string): ResourceEntry {
    return {
        key: {
            topicId: 'playwright.queue.v1',
            resourceId,
            contextId: 'browser-indexeddb'
        },
        resource,
        typeId: 'playwright.queue.v1',
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'playwright',
            createdTs: Temporal.PlainDateTime.from('2026-01-01T12:00:00'),
            expiryTs: Temporal.Instant.from('9999-12-31T23:59:59.999Z')
        },
        status: EntityStatus.NEW,
        dequeueAudit: { attempts: 0 }
    };
}

async function createLegacyQueueDatabase(
    dbName: string,
    row: Omit<StoredResourceEntry, 'revision'>
): Promise<void> {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
        request.result
            .createObjectStore(STORE_NAME, { keyPath: 'keyString' })
            .put(row);
    };
    const database = await readIndexedDbRequest(request);
    database.close();
}

async function createTokenlessAdmissionDatabase(
    dbName: string,
    storeName: string
): Promise<void> {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
        request.result
            .createObjectStore(storeName, { keyPath: 'key' })
            .put({
                key: 'legacy',
                value: 'legacy',
                expireAtTimestamp: Number.MAX_SAFE_INTEGER
            });
    };
    const database = await readIndexedDbRequest(request);
    database.close();
}

async function inspectQueueDatabase(
    dbName: string,
    legacyKey: Key
): Promise<
    Pick<IndexedDbTransactionWriteBrowserProbe, 'databaseVersion' | 'fairnessIndexPresent' | 'migratedRevision'>
> {
    const database = await readIndexedDbRequest(indexedDB.open(dbName));
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const row = await readIndexedDbRequest<StoredResourceEntry>(
            store.get(toKeyAsString(legacyKey))
        );
        await waitForTransaction(transaction);
        return {
            databaseVersion: database.version,
            fairnessIndexPresent: store.indexNames.contains(
                IndexedDbQueueBox.FAIRNESS_INDEX_NAME
            ),
            migratedRevision: row.revision
        };
    }
    finally {
        database.close();
    }
}

async function readIndexedDbRequest<Value>(request: IDBRequest<Value>): Promise<Value> {
    return await new Promise<Value>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

async function waitForTransaction(transaction: IDBTransaction): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
}
