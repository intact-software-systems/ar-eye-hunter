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

export interface IndexedDbTransactionWriteBrowserProbe extends IndexedDbAtomicAdmissionProbe {
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
    const atomicState = await runAtomicAdmissionStorageProbe();

    return {
        ...databaseState,
        ...admissionState,
        ...atomicState,
        storedResource: firstRead?.resource,
        concurrentResults: concurrent.map((entry) => entry.resource),
        durableWinner: durableWinner?.resource
    };
}

async function runAdmissionStorageProbe(): Promise<
    Pick<IndexedDbTransactionWriteBrowserProbe, 'admissionTokenPresent' | 'guardedAdmissionBatchRolledBack'>
> {
    const database = await openIndexedDbAdmissionDatabase(
        `playwright-indexeddb-admission-${crypto.randomUUID()}`,
        ADMISSION_STORE_NAME
    );
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

async function runAtomicAdmissionStorageProbe(): Promise<IndexedDbAtomicAdmissionProbe> {
    const dbName = `playwright-atomic-admission-${crypto.randomUUID()}`;
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
        storeName: AL_ADMISSION_WORK_STORE_NAME
    });
    try {
        const reserved = await queue.reserveEntries(new Set([entry.typeId]), new Set([EntityStatus.NEW]), 1);
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
): Promise<Pick<IndexedDbTransactionWriteBrowserProbe, 'databaseVersion' | 'fairnessIndexPresent' | 'storedRevision'>> {
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
