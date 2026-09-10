import {
    readIndexedDbRequest,
    readIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import type { IndexedDbStoreDefinition } from '../persistence/open-indexed-db.ts';
import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import type { ResourceInboxWorkPage } from './queue-box-types.ts';
import { EntityStatus, type ResourceEntryKeyString } from './ResourceEntry.ts';

interface ReadFairnessStoredQueueEntriesInput {
    readonly db: IDBDatabase;
    readonly indexName: string;
    readonly maxToScan: number;
    readonly overdueBeforeEpochMs: number;
    readonly storeName: string;
    readonly typeIds: readonly string[];
}

interface ReadStoredQueueEntriesByTypeStatusInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly typeId: string;
    readonly status: EntityStatus;
    readonly maxToRead: number;
}

interface ReadStoredQueueEntriesByTypesAndStatusesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly typeIds: Iterable<string>;
    readonly statusIds: Iterable<EntityStatus>;
    readonly maxToReadPerCombination: number;
}

interface ReadExpiredStoredQueueEntriesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly nowEpochMs: number;
    readonly maxToRead: number;
}

interface ReadCompletedStoredQueueEntriesBeforeInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly status: EntityStatus;
    readonly endBeforeEpochMs: number;
    readonly maxToRead: number;
}

interface ReadCompletedStoredQueueEntriesAcrossStatusesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly statusIds: Iterable<EntityStatus>;
    readonly endBeforeEpochMs: number;
    readonly maxToRead: number;
}

interface ReadFairnessDueStoredQueueEntriesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly typeId: string;
    readonly dueBeforeEpochMs: number;
    readonly maxToRead: number;
}

export const INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME = 'by-type-status-next-key';
const INDEXED_DB_QUEUE_WORK_INDEX_NAME = 'by-type-status-key';
export const INDEXED_DB_QUEUE_EXPIRY_INDEX_NAME = 'by-expiry';
export const INDEXED_DB_QUEUE_STATUS_END_INDEX_NAME = 'by-status-end';

export function toIndexedDbQueueStoreDefinition(name: string): IndexedDbStoreDefinition<object> {
    return {
        name,
        keyPath: 'keyString',
        indexes: [
            {
                name: INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME,
                keyPath: ['typeId', 'status', 'fairnessDueEpochMs', 'keyString'],
                unique: false
            },
            {
                name: INDEXED_DB_QUEUE_WORK_INDEX_NAME,
                keyPath: ['typeId', 'status', 'keyString'],
                unique: false
            },
            {
                name: INDEXED_DB_QUEUE_EXPIRY_INDEX_NAME,
                keyPath: 'expiryEpochMs',
                unique: false
            },
            {
                name: INDEXED_DB_QUEUE_STATUS_END_INDEX_NAME,
                keyPath: ['status', 'endEpochMs'],
                unique: false
            }
        ]
    };
}

export async function readStoredQueueWorkPage(
    db: IDBDatabase,
    storeName: string,
    request: ResourceInboxWorkPage.Request
): Promise<readonly StoredResourceEntry[]> {
    const lower = request.cursor === null
        ? [request.typeId, request.status]
        : [request.typeId, request.status, request.cursor.position];
    const range = IDBKeyRange.bound(lower, [request.typeId, request.status, []], request.cursor !== null, true);
    const transaction = db.transaction(storeName, 'readonly');
    const values = await readIndexedDbTransaction(transaction, async () =>
        await readIndexedDbRequest(
            transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_WORK_INDEX_NAME).getAll(range, request.maxToRead)
        ));
    return values.map(decodeStoredResourceEntryValue);
}

export async function readStoredQueueEntry(
    db: IDBDatabase,
    storeName: string,
    keyString: ResourceEntryKeyString
): Promise<StoredResourceEntry | undefined> {
    const entries = await readStoredQueueEntries(db, storeName, [keyString]);
    return entries.get(keyString);
}

export async function readStoredQueueEntries(
    db: IDBDatabase,
    storeName: string,
    keyStrings: readonly ResourceEntryKeyString[]
): Promise<ReadonlyMap<ResourceEntryKeyString, StoredResourceEntry>> {
    if (keyStrings.length === 0) {
        return new Map();
    }

    const transaction = db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const stored = await readIndexedDbTransaction(
        transaction,
        async () =>
            await Promise.all(
                keyStrings.map((key) => readIndexedDbRequest(store.get(key)))
            )
    );
    const entries = new Map<ResourceEntryKeyString, StoredResourceEntry>();
    for (const [index, value] of stored.entries()) {
        if (value !== undefined) {
            const entry = decodeStoredResourceEntryValue(value);
            if (entry.keyString !== keyStrings[index]) {
                throw new TypeError('IndexedDB queue lookup returned a row for another key');
            }
            entries.set(keyStrings[index], entry);
        }
    }
    return entries;
}

/** getAllKeys() has no type/status to scope by; it is the one caller that still needs every row. */
export async function readStoredQueueEntriesForKeyEnumeration(
    db: IDBDatabase,
    storeName: string
): Promise<readonly StoredResourceEntry[]> {
    const transaction = db.transaction(storeName, 'readonly');
    const entries = await readIndexedDbTransaction(
        transaction,
        async () => await readIndexedDbRequest(transaction.objectStore(storeName).getAll())
    );
    return entries.map(decodeStoredResourceEntryValue);
}

export async function readStoredQueueEntriesByTypeStatus(
    input: ReadStoredQueueEntriesByTypeStatusInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, typeId, status, maxToRead } = input;
    const transaction = db.transaction(storeName, 'readonly');
    const range = IDBKeyRange.bound([typeId, status], [typeId, status, []]);
    const values = await readIndexedDbTransaction(
        transaction,
        async () =>
            await readIndexedDbRequest(
                transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_WORK_INDEX_NAME).getAll(range, maxToRead)
            )
    );
    return values.map(decodeStoredResourceEntryValue);
}

/**
 * The candidate-gathering loop for per-type reservation reads: callers keep one flat list plus
 * their unchanged per-row predicate loop, instead of each owning this typeId x status nesting.
 */
export async function readStoredQueueEntriesByTypesAndStatuses(
    input: ReadStoredQueueEntriesByTypesAndStatusesInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, typeIds, statusIds, maxToReadPerCombination } = input;
    const statuses = [...statusIds];
    const candidates: StoredResourceEntry[] = [];
    for (const typeId of typeIds) {
        for (const status of statuses) {
            candidates.push(
                ...await readStoredQueueEntriesByTypeStatus({
                    db,
                    storeName,
                    typeId,
                    status,
                    maxToRead: maxToReadPerCombination
                })
            );
        }
    }
    return candidates;
}

export async function readExpiredStoredQueueEntries(
    input: ReadExpiredStoredQueueEntriesInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, nowEpochMs, maxToRead } = input;
    const transaction = db.transaction(storeName, 'readonly');
    const range = IDBKeyRange.upperBound(nowEpochMs);
    const values = await readIndexedDbTransaction(
        transaction,
        async () =>
            await readIndexedDbRequest(
                transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_EXPIRY_INDEX_NAME).getAll(range, maxToRead)
            )
    );
    return values.map(decodeStoredResourceEntryValue);
}

export async function readCompletedStoredQueueEntriesBefore(
    input: ReadCompletedStoredQueueEntriesBeforeInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, status, endBeforeEpochMs, maxToRead } = input;
    const transaction = db.transaction(storeName, 'readonly');
    const range = IDBKeyRange.bound([status, Number.MIN_SAFE_INTEGER], [status, endBeforeEpochMs]);
    const values = await readIndexedDbTransaction(
        transaction,
        async () =>
            await readIndexedDbRequest(
                transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_STATUS_END_INDEX_NAME).getAll(
                    range,
                    maxToRead
                )
            )
    );
    return values.map(decodeStoredResourceEntryValue);
}

/** Shares one shrinking maxToRead budget across every completed status the caller sweeps. */
export async function readCompletedStoredQueueEntriesAcrossStatuses(
    input: ReadCompletedStoredQueueEntriesAcrossStatusesInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, statusIds, endBeforeEpochMs, maxToRead } = input;
    const candidates: StoredResourceEntry[] = [];
    let remainingBudget = maxToRead;
    for (const status of statusIds) {
        if (remainingBudget <= 0) {
            break;
        }
        const rows = await readCompletedStoredQueueEntriesBefore({
            db,
            storeName,
            status,
            endBeforeEpochMs,
            maxToRead: remainingBudget
        });
        candidates.push(...rows);
        remainingBudget -= rows.length;
    }
    return candidates;
}

/** A cheap existence probe: is there a due RETRY row for this type, ordered by the fairness index. */
export async function readFairnessDueStoredQueueEntries(
    input: ReadFairnessDueStoredQueueEntriesInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, typeId, dueBeforeEpochMs, maxToRead } = input;
    const transaction = db.transaction(storeName, 'readonly');
    const range = IDBKeyRange.bound(
        [typeId, EntityStatus.RETRY, 0],
        [typeId, EntityStatus.RETRY, dueBeforeEpochMs]
    );
    const values = await readIndexedDbTransaction(
        transaction,
        async () =>
            await readIndexedDbRequest(
                transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME).getAll(range, maxToRead)
            )
    );
    return values.map(decodeStoredResourceEntryValue);
}

export async function readFairnessStoredQueueEntries(
    input: ReadFairnessStoredQueueEntriesInput
): Promise<ReadonlyMap<string, readonly StoredResourceEntry[]>> {
    const transaction = input.db.transaction(input.storeName, 'readonly');
    return await readIndexedDbTransaction(transaction, async () => {
        const index = transaction.objectStore(input.storeName).index(input.indexName);
        const states = await Promise.all(input.typeIds.map(async (typeId) => ({
            typeId,
            entries: await readNextFairnessStoredQueueEntries({
                index,
                typeId,
                overdueBeforeEpochMs: input.overdueBeforeEpochMs
            })
        })));
        let scanned = input.typeIds.length;
        const active = new Set(states.filter((state) => state.entries.length > 0));
        while (scanned < input.maxToScan && active.size > 0) {
            const selected = [...active].reduce(earlierFairnessReadState);
            const next = await readNextFairnessStoredQueueEntries({
                index,
                typeId: selected.typeId,
                overdueBeforeEpochMs: input.overdueBeforeEpochMs,
                after: selected.entries.at(-1)
            });
            scanned += 1;
            if (next.length === 0) {
                active.delete(selected);
                continue;
            }
            selected.entries.push(next[0]);
        }
        return new Map(states.map((state) => [state.typeId, state.entries]));
    });
}

interface FairnessReadState {
    readonly typeId: string;
    readonly entries: StoredResourceEntry[];
}

interface ReadNextFairnessStoredQueueEntriesInput {
    readonly index: IDBIndex;
    readonly typeId: string;
    readonly overdueBeforeEpochMs: number;
    readonly after?: StoredResourceEntry;
}

async function readNextFairnessStoredQueueEntries(
    input: ReadNextFairnessStoredQueueEntriesInput
): Promise<StoredResourceEntry[]> {
    const lower = input.after === undefined
        ? [input.typeId, EntityStatus.RETRY, Number.MIN_SAFE_INTEGER, '']
        : [
            input.typeId,
            EntityStatus.RETRY,
            input.after.fairnessDueEpochMs!,
            input.after.keyString
        ];
    const values = await readIndexedDbRequest(input.index.getAll(
        IDBKeyRange.bound(
            lower,
            [input.typeId, EntityStatus.RETRY, input.overdueBeforeEpochMs, '\uffff'],
            input.after !== undefined
        ),
        1
    ));
    return values.map(decodeStoredResourceEntryValue);
}

function earlierFairnessReadState(
    left: FairnessReadState,
    right: FairnessReadState
): FairnessReadState {
    const leftEntry = left.entries.at(-1)!;
    const rightEntry = right.entries.at(-1)!;
    const dueOrder = leftEntry.fairnessDueEpochMs! - rightEntry.fairnessDueEpochMs!;
    if (dueOrder !== 0) {
        return dueOrder < 0 ? left : right;
    }
    return indexedDB.cmp(leftEntry.keyString, rightEntry.keyString) <= 0 ? left : right;
}
