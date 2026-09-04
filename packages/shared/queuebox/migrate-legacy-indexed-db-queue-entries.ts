import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import { toError } from '../resilience/to-error.ts';
import {
    decodeLegacyStoredResourceEntryValue,
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    encodeStoredResourceEntry,
    type LegacyStoredResourceEntry,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import { IndexedDbQueueWriteConflictError } from './indexed-db-queue-write-conflict-error.ts';
import { NEVER_EXPIRE_TS } from './ResourceEntry.ts';

interface ComputedLegacyIndexedDbQueueEntryMigration {
    readonly expected: LegacyStoredResourceEntry;
    readonly value: StoredResourceEntry;
}

export async function migrateLegacyIndexedDbQueueEntries(
    db: IDBDatabase,
    storeName: string
): Promise<void> {
    const computed = (await readLegacyIndexedDbQueueEntries(db, storeName)).map(
        computeLegacyIndexedDbQueueEntryMigration
    );
    for (const migration of computed) {
        if (!await writeLegacyIndexedDbQueueEntryMigration(db, storeName, migration)) {
            if (await isLegacyIndexedDbQueueEntryAlreadyMigrated(db, storeName, migration)) {
                continue;
            }
            throw new IndexedDbQueueWriteConflictError(
                `Legacy IndexedDB queue migration conflicted: ${migration.expected.keyString}`
            );
        }
    }
}

async function readLegacyIndexedDbQueueEntries(
    db: IDBDatabase,
    storeName: string
): Promise<readonly LegacyStoredResourceEntry[]> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const values = await readIndexedDbRequest(transaction.objectStore(storeName).getAll());
    await completed;
    return values
        .filter(isRevisionlessQueueEntry)
        .map(decodeLegacyStoredResourceEntryValue);
}

function computeLegacyIndexedDbQueueEntryMigration(
    expected: LegacyStoredResourceEntry
): ComputedLegacyIndexedDbQueueEntryMigration {
    const current = toCurrentStoredResourceEntry(expected);
    return {
        expected,
        value: encodeStoredResourceEntry(
            decodeStoredResourceEntry(current),
            0
        )
    };
}

function toCurrentStoredResourceEntry(
    legacy: LegacyStoredResourceEntry
): StoredResourceEntry {
    return decodeStoredResourceEntryValue({
        ...legacy,
        revision: 0,
        audit: {
            ...legacy.audit,
            expiryTs: legacy.audit.expiryTs ?? NEVER_EXPIRE_TS.toString()
        }
    });
}

async function writeLegacyIndexedDbQueueEntryMigration(
    db: IDBDatabase,
    storeName: string,
    computed: ComputedLegacyIndexedDbQueueEntryMigration
): Promise<boolean> {
    validateComputedLegacyIndexedDbQueueEntryMigration(computed);
    return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.get(computed.expected.keyString);
        let conflict = false;
        let resultError: Error | undefined;

        transaction.oncomplete = () => resolve(true);
        transaction.onabort = () => {
            if (resultError) {
                reject(resultError);
                return;
            }
            if (conflict) {
                resolve(false);
                return;
            }
            reject(transaction.error ?? new Error('IndexedDB queue migration aborted'));
        };
        request.onsuccess = () => {
            try {
                if (
                    !isRevisionlessQueueEntry(request.result) ||
                    !isSameLegacyIndexedDbQueueEntry(
                        computed.expected,
                        request.result as LegacyStoredResourceEntry
                    )
                ) {
                    conflict = true;
                    transaction.abort();
                    return;
                }
                store.put(computed.value);
            }
            catch (error) {
                resultError = toError(error);
                transaction.abort();
            }
        };
    });
}

function validateComputedLegacyIndexedDbQueueEntryMigration(
    computed: ComputedLegacyIndexedDbQueueEntryMigration
): void {
    const expected = decodeLegacyStoredResourceEntryValue(computed.expected);
    const value = encodeStoredResourceEntry(
        decodeStoredResourceEntry(toCurrentStoredResourceEntry(expected)),
        0
    );
    if (!isSameStoredIndexedDbQueueEntry(value, computed.value)) {
        throw new TypeError('Legacy IndexedDB queue migration differs from its canonical computation');
    }
}

async function isLegacyIndexedDbQueueEntryAlreadyMigrated(
    db: IDBDatabase,
    storeName: string,
    computed: ComputedLegacyIndexedDbQueueEntryMigration
): Promise<boolean> {
    const transaction = db.transaction(storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const value = await readIndexedDbRequest(
        transaction.objectStore(storeName).get(computed.expected.keyString)
    );
    await completed;
    if (value === undefined) {
        return true;
    }
    if (isRevisionlessQueueEntry(value)) {
        return false;
    }
    decodeStoredResourceEntryValue(value);
    return true;
}

function isRevisionlessQueueEntry(value: IDBRequest['result']): boolean {
    return value !== null &&
        typeof value === 'object' &&
        !Object.prototype.hasOwnProperty.call(value, 'revision');
}

function isSameLegacyIndexedDbQueueEntry(
    left: LegacyStoredResourceEntry,
    right: LegacyStoredResourceEntry
): boolean {
    return left.keyString === right.keyString &&
        left.fairnessDueEpochMs === right.fairnessDueEpochMs &&
        left.key.topicId === right.key.topicId &&
        left.key.resourceId === right.key.resourceId &&
        left.key.contextId === right.key.contextId &&
        left.resource === right.resource &&
        left.typeId === right.typeId &&
        left.audit.date === right.audit.date &&
        left.audit.createdBy === right.audit.createdBy &&
        left.audit.createdTs === right.audit.createdTs &&
        left.audit.expiryTs === right.audit.expiryTs &&
        left.status === right.status &&
        left.dequeueAudit.startTs === right.dequeueAudit.startTs &&
        left.dequeueAudit.endTs === right.dequeueAudit.endTs &&
        left.dequeueAudit.nextTs === right.dequeueAudit.nextTs &&
        left.dequeueAudit.attempts === right.dequeueAudit.attempts;
}

function isSameStoredIndexedDbQueueEntry(
    left: StoredResourceEntry,
    right: StoredResourceEntry
): boolean {
    const { revision: leftRevision, ...leftLegacy } = left;
    const { revision: rightRevision, ...rightLegacy } = right;
    return leftRevision === rightRevision &&
        isSameLegacyIndexedDbQueueEntry(leftLegacy, rightLegacy);
}
