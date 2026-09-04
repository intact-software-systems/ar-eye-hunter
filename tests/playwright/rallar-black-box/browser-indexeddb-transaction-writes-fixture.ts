import { Temporal } from '@js-temporal/polyfill';

import {
    openIndexedDbAdmissionDatabase
} from '../../../packages/shared/alm/open-indexed-db-admission-database.ts';
import {
    readIndexedDbAdmissionSnapshot
} from '../../../packages/shared/alm/read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations
} from '../../../packages/shared/alm/write-indexed-db-admission-mutations.ts';
import {
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
    readonly storedResource: string | undefined;
    readonly storedRevision: number;
    readonly concurrentResults: readonly string[];
    readonly durableWinner: string | undefined;
    readonly admissionTokenPresent: boolean;
    readonly guardedAdmissionBatchRolledBack: boolean;
}

export async function runIndexedDbTransactionWriteBrowserProbe(): Promise<IndexedDbTransactionWriteBrowserProbe> {
    const dbName = `playwright-indexeddb-queue-${crypto.randomUUID()}`;
    const storedEntry = createQueueEntry('stored', 'stored-value');
    const firstQueue = new IndexedDbQueueBox({ dbName, storeName: STORE_NAME });
    await firstQueue.enqueue(storedEntry);
    const secondQueue = new IndexedDbQueueBox({ dbName, storeName: STORE_NAME });
    const [firstRead, secondRead] = await Promise.all([
        firstQueue.getItem(storedEntry.key),
        secondQueue.getItem(storedEntry.key)
    ]);
    if (secondRead?.resource !== firstRead?.resource) {
        throw new Error('Concurrent IndexedDB readers did not observe the same stored row');
    }
    const firstCandidate = createQueueEntry('concurrent', 'first-value');
    const secondCandidate = createQueueEntry('concurrent', 'second-value');
    const concurrent = await Promise.all([
        firstQueue.enqueueIfAbsent(firstCandidate),
        secondQueue.enqueueIfAbsent(secondCandidate)
    ]);
    const durableWinner = await firstQueue.getItem(firstCandidate.key);
    const databaseState = await inspectQueueDatabase(dbName, storedEntry.key);
    const admissionState = await runAdmissionStorageProbe();

    return {
        ...databaseState,
        ...admissionState,
        storedResource: firstRead?.resource,
        concurrentResults: concurrent.map((entry) => entry.resource),
        durableWinner: durableWinner?.resource
    };
}

async function runAdmissionStorageProbe(): Promise<
    Pick<IndexedDbTransactionWriteBrowserProbe, 'admissionTokenPresent' | 'guardedAdmissionBatchRolledBack'>
> {
    const dbName = `playwright-indexeddb-admission-${crypto.randomUUID()}`;
    const storeName = 'admission';
    const database = await openIndexedDbAdmissionDatabase(dbName, storeName);
    try {
        const initial = await readIndexedDbAdmissionSnapshot(
            database,
            storeName,
            { kind: 'revision' }
        );
        const initialCommitted = await writeIndexedDbAdmissionMutations({
            db: database,
            storeName,
            expectedRevision: initial.revision,
            mutations: [{
                kind: 'set',
                stored: {
                    key: 'current',
                    value: 'current',
                    expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                    writeToken: 'current-row-token'
                }
            }],
            revisionWrite: computeIndexedDbAdmissionRevisionWrite(initial.revision)
        });
        if (!initialCommitted) {
            throw new Error('Initial IndexedDB admission write conflicted');
        }
        const stored = await readIndexedDbAdmissionSnapshot(
            database,
            storeName,
            { kind: 'key', key: 'current' }
        );
        const committed = await writeIndexedDbAdmissionMutations({
            db: database,
            storeName,
            expectedRevision: stored.revision,
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
                    key: 'current',
                    expectedWriteToken: 'not-the-current-token'
                }
            ],
            revisionWrite: computeIndexedDbAdmissionRevisionWrite(stored.revision)
        });
        const afterConflict = await readIndexedDbAdmissionSnapshot(
            database,
            storeName,
            { kind: 'prefixes', prefixes: ['current', 'must-roll-back'] }
        );
        return {
            admissionTokenPresent: stored.stored[0]?.writeToken === 'current-row-token',
            guardedAdmissionBatchRolledBack: !committed &&
                afterConflict.stored.some((row) => row.key === 'current') &&
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

async function inspectQueueDatabase(
    dbName: string,
    storedKey: Key
): Promise<Pick<IndexedDbTransactionWriteBrowserProbe, 'databaseVersion' | 'fairnessIndexPresent' | 'storedRevision'>> {
    const database = await readIndexedDbRequest(indexedDB.open(dbName));
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const row = await readIndexedDbRequest<StoredResourceEntry>(
            store.get(toKeyAsString(storedKey))
        );
        await waitForTransaction(transaction);
        return {
            databaseVersion: database.version,
            fairnessIndexPresent: store.indexNames.contains(
                IndexedDbQueueBox.FAIRNESS_INDEX_NAME
            ),
            storedRevision: row.revision
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
