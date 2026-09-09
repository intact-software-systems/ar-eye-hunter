import { Temporal } from '@js-temporal/polyfill';

import {
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from '../../../packages/shared/alm/open-indexed-db-admission-database.ts';
import {
    readIndexedDbAdmissionSnapshot
} from '../../../packages/shared/alm/read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations,
    type WriteIndexedDbAdmissionMutationsInput
} from '../../../packages/shared/alm/write-indexed-db-admission-mutations.ts';
import { createPassThroughIndexedDbOperationObserver } from '../../../packages/shared/persistence/indexed-db-operation-observer.ts';
import {
    readIndexedDbRequest,
    readIndexedDbTransaction
} from '../../../packages/shared/persistence/indexed-db-request.ts';
import { IndexedDbConnection } from '../../../packages/shared/persistence/open-indexed-db.ts';
import {
    type StoredResourceEntry
} from '../../../packages/shared/queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueuePut,
    type ComputedIndexedDbQueueMutation
} from '../../../packages/shared/queuebox/indexed-db-queue-box-entry.ts';
import { INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME } from '../../../packages/shared/queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '../../../packages/shared/queuebox/indexed-db-queue-box.ts';
import {
    EntityStatus,
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '../../../packages/shared/queuebox/ResourceEntry.ts';

const STORE_NAME = 'entries';
const ADMISSION_STORE_NAME = 'admission';

interface IndexedDbAtomicAdmissionProbe {
    readonly queuedWorkReplayed: boolean;
    readonly queueConflictRolledBackAdmission: boolean;
    readonly admissionConflictRolledBackQueue: boolean;
}

interface IndexedDbQueueStorageProbe {
    readonly databaseVersion: number;
    readonly fairnessIndexPresent: boolean;
    readonly storedRevision: number;
}

interface IndexedDbAdmissionStorageProbe {
    readonly admissionTokenPresent: boolean;
    readonly guardedAdmissionBatchRolledBack: boolean;
}

export interface IndexedDbTransactionWriteBrowserProbe
    extends IndexedDbAtomicAdmissionProbe, IndexedDbQueueStorageProbe, IndexedDbAdmissionStorageProbe {
    readonly storedResource: string | undefined;
    readonly concurrentResults: readonly string[];
    readonly durableWinner: string | undefined;
}

export async function runIndexedDbTransactionWriteBrowserProbe(
    databaseId: string
): Promise<IndexedDbTransactionWriteBrowserProbe> {
    const dbName = `playwright-indexeddb-queue-${databaseId}`;
    const storedEntry = createQueueEntry('stored', 'stored-value');
    const firstQueue = new IndexedDbQueueBox({
        dbName,
        storeName: STORE_NAME,
        observer: createPassThroughIndexedDbOperationObserver()
    });
    await firstQueue.enqueue(storedEntry);
    const secondQueue = new IndexedDbQueueBox({
        dbName,
        storeName: STORE_NAME,
        observer: createPassThroughIndexedDbOperationObserver()
    });
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
    const admissionState = await runAdmissionStorageProbe(`playwright-indexeddb-admission-${databaseId}`);
    const atomicState = await runAtomicAdmissionStorageProbe(`playwright-atomic-admission-${databaseId}`);

    return {
        ...databaseState,
        ...admissionState,
        ...atomicState,
        storedResource: firstRead?.resource,
        concurrentResults: concurrent.map((entry) => entry.resource),
        durableWinner: durableWinner?.resource
    };
}

async function runAdmissionStorageProbe(dbName: string): Promise<IndexedDbAdmissionStorageProbe> {
    const database = await openIndexedDbAdmissionDatabase(dbName, ADMISSION_STORE_NAME);
    try {
        const initial = computeBrowserAdmissionWrite(0, createQueueEntry('current', 'current'), []);
        if (!await writeIndexedDbAdmissionMutations({ ...initial, db: database })) {
            throw new Error('Initial IndexedDB admission write conflicted');
        }
        const stored = await readIndexedDbAdmissionSnapshot(database, ADMISSION_STORE_NAME, {
            kind: 'key',
            key: 'current'
        });
        const conflict = computeBrowserAdmissionWrite(stored.revision, createQueueEntry('must-roll-back', 'new'), []);
        const committed = await writeIndexedDbAdmissionMutations({
            ...conflict,
            db: database,
            mutations: [...conflict.mutations, {
                kind: 'remove-if-write-token',
                key: 'current',
                expectedWriteToken: 'not-the-current-token'
            }]
        });
        const afterConflict = await readIndexedDbAdmissionSnapshot(database, ADMISSION_STORE_NAME, {
            kind: 'prefixes',
            prefixes: ['current', 'must-roll-back']
        });
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

async function runAtomicAdmissionStorageProbe(dbName: string): Promise<IndexedDbAtomicAdmissionProbe> {
    const entry = createQueueEntry('atomic-work', 'retained-message');
    const original = await openIndexedDbAdmissionDatabase(dbName, ADMISSION_STORE_NAME);
    try {
        const computed = computeBrowserAdmissionWrite(0, entry, [computeIndexedDbQueuePut(undefined, entry)]);
        if (!await writeIndexedDbAdmissionMutations({ ...computed, db: original })) {
            throw new Error('Initial atomic admission conflicted');
        }
    }
    finally {
        original.close();
    }
    const reopened = await openIndexedDbAdmissionDatabase(dbName, ADMISSION_STORE_NAME);
    const queue = new IndexedDbQueueBox({
        connection: new IndexedDbConnection(async () => reopened),
        storeName: AL_ADMISSION_WORK_STORE_NAME,
        observer: createPassThroughIndexedDbOperationObserver()
    });
    try {
        const reserved = await queue.reserveEntries({
            typeIds: new Set([entry.typeId]),
            statusIds: new Set([EntityStatus.NEW]),
            reservationInput: 1
        });
        const queuedWorkReplayed = reserved.size === 1 && [...reserved.values()][0].resource === entry.resource;
        return {
            queuedWorkReplayed,
            queueConflictRolledBackAdmission: await probeAtomicQueueConflict(reopened, entry),
            admissionConflictRolledBackQueue: await probeAtomicAdmissionConflict(reopened, queue)
        };
    }
    finally {
        reopened.close();
    }
}

async function probeAtomicQueueConflict(database: IDBDatabase, existing: ResourceEntry): Promise<boolean> {
    const computed = computeBrowserAdmissionWrite(1, createQueueEntry('must-roll-back', 'new'), [
        computeIndexedDbQueuePut(undefined, existing)
    ]);
    const committed = await writeIndexedDbAdmissionMutations({ ...computed, db: database });
    const after = await readIndexedDbAdmissionSnapshot(database, ADMISSION_STORE_NAME, {
        kind: 'key',
        key: 'must-roll-back'
    });
    return !committed && after.revision === 1 && after.stored.length === 0;
}

async function probeAtomicAdmissionConflict(database: IDBDatabase, queue: IndexedDbQueueBox): Promise<boolean> {
    const entry = createQueueEntry('stale-admission', 'stale');
    const computed = computeBrowserAdmissionWrite(0, entry, [computeIndexedDbQueuePut(undefined, entry)]);
    const committed = await writeIndexedDbAdmissionMutations({ ...computed, db: database });
    return !committed && await queue.getItem(entry.key) === undefined;
}

function computeBrowserAdmissionWrite(
    expectedRevision: number,
    entry: ResourceEntry,
    queueMutations: readonly ComputedIndexedDbQueueMutation[]
): Omit<WriteIndexedDbAdmissionMutationsInput, 'db'> {
    return {
        storeName: ADMISSION_STORE_NAME,
        expectedRevision,
        mutations: [{
            kind: 'set',
            stored: {
                key: entry.key.resourceId,
                value: entry.resource,
                expireAtTimestamp: Number.MAX_SAFE_INTEGER,
                writeToken: `${entry.key.resourceId}-row-token`
            }
        }],
        queueMutations,
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(expectedRevision)
    };
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
): Promise<IndexedDbQueueStorageProbe> {
    const database = await readIndexedDbRequest(indexedDB.open(dbName));
    try {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const row = await readIndexedDbTransaction(
            transaction,
            () => readIndexedDbRequest<StoredResourceEntry>(store.get(toKeyAsString(storedKey)))
        );
        return {
            databaseVersion: database.version,
            fairnessIndexPresent: store.indexNames.contains(
                INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME
            ),
            storedRevision: row.revision
        };
    }
    finally {
        database.close();
    }
}
