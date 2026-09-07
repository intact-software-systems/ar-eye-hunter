import {
    readIndexedDbRequest,
    readIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import type { IndexedDbStoreDefinition } from '../persistence/open-indexed-db.ts';
import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import { EntityStatus, type ResourceEntryKeyString } from './ResourceEntry.ts';

interface ReadFairnessStoredQueueEntriesInput {
    readonly db: IDBDatabase;
    readonly indexName: string;
    readonly maxToScan: number;
    readonly overdueBeforeEpochMs: number;
    readonly storeName: string;
    readonly typeIds: readonly string[];
}

export const INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME = 'by-type-status-next-key';

export function toIndexedDbQueueStoreDefinition(name: string): IndexedDbStoreDefinition<object> {
    return {
        name,
        keyPath: 'keyString',
        indexes: [{
            name: INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME,
            keyPath: ['typeId', 'status', 'fairnessDueEpochMs', 'keyString'],
            unique: false
        }]
    };
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

export async function readAllStoredQueueEntries(
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
