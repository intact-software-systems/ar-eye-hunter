import {
    readIndexedDbRequest,
    waitForIndexedDbTransaction
} from '../persistence/indexed-db-request.ts';
import {
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry.ts';
import { EntityStatus, type ResourceEntryKeyString } from './ResourceEntry.ts';

export type ReadFairnessStoredQueueEntriesInput = Readonly<{
    db: IDBDatabase;
    indexName: string;
    maxToScan: number;
    overdueBeforeEpochMs: number;
    storeName: string;
    typeIds: readonly string[];
}>;

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
    const completed = waitForIndexedDbTransaction(transaction);
    const store = transaction.objectStore(storeName);
    const stored = await Promise.all(
        keyStrings.map((key) => readIndexedDbRequest<unknown>(store.get(key)))
    );
    await completed;
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
    const completed = waitForIndexedDbTransaction(transaction);
    const entries = await readIndexedDbRequest<unknown[]>(
        transaction.objectStore(storeName).getAll()
    );
    await completed;
    return entries.map(decodeStoredResourceEntryValue);
}

export async function readFairnessStoredQueueEntries(
    input: ReadFairnessStoredQueueEntriesInput
): Promise<ReadonlyMap<string, readonly StoredResourceEntry[]>> {
    const transaction = input.db.transaction(input.storeName, 'readonly');
    const completed = waitForIndexedDbTransaction(transaction);
    const index = transaction.objectStore(input.storeName).index(input.indexName);
    const states = await Promise.all(input.typeIds.map(async (typeId) => ({
        typeId,
        entries: await readNextFairnessStoredQueueEntries(
            index,
            typeId,
            input.overdueBeforeEpochMs
        )
    })));
    let scanned = input.typeIds.length;
    const active = new Set(states.filter((state) => state.entries.length > 0));
    while (scanned < input.maxToScan && active.size > 0) {
        const selected = [...active].reduce(earlierFairnessReadState);
        const next = await readNextFairnessStoredQueueEntries(
            index,
            selected.typeId,
            input.overdueBeforeEpochMs,
            selected.entries.at(-1)
        );
        scanned += 1;
        if (next.length === 0) {
            active.delete(selected);
            continue;
        }
        selected.entries.push(next[0]);
    }
    await completed;
    return new Map(states.map((state) => [state.typeId, state.entries]));
}

interface FairnessReadState {
    readonly typeId: string;
    readonly entries: StoredResourceEntry[];
}

async function readNextFairnessStoredQueueEntries(
    index: IDBIndex,
    typeId: string,
    overdueBeforeEpochMs: number,
    after?: StoredResourceEntry
): Promise<StoredResourceEntry[]> {
    const lower = after === undefined
        ? [typeId, EntityStatus.RETRY, Number.MIN_SAFE_INTEGER, '']
        : [typeId, EntityStatus.RETRY, after.fairnessDueEpochMs!, after.keyString];
    const values = await readIndexedDbRequest<unknown[]>(index.getAll(
        IDBKeyRange.bound(
            lower,
            [typeId, EntityStatus.RETRY, overdueBeforeEpochMs, '\uffff'],
            after !== undefined
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
