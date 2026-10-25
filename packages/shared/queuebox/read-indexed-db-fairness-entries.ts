import { readIndexedDbRequest, readIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import { decodeStoredResourceEntryValue, type StoredResourceEntry } from './indexed-db-queue-box-entry-codec.ts';
import { isResourceInboxTopicSelected } from './resource-inbox/is-resource-inbox-topic-selected.ts';
import { EntityStatus } from './ResourceEntry.ts';

interface ReadFairnessStoredQueueEntriesInput {
    readonly allowedTopicIds?: ReadonlySet<string>;
    readonly db: IDBDatabase;
    readonly indexName: string;
    readonly maxToScan: number;
    readonly overdueBeforeEpochMs: number;
    readonly storeName: string;
    readonly typeIds: readonly string[];
    /** Rows of these contexts are read past without counting against the scan budget. */
    readonly excludedContextIds: ReadonlySet<string> | undefined;
}

export async function readIndexedDbFairnessEntries(
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
        // An excluded context's row is read past for free, so the budget counts only rows a claim could take.
        const isExcluded = (entry: StoredResourceEntry | undefined) =>
            entry !== undefined && (input.excludedContextIds?.has(entry.key.contextId) === true ||
                (!isResourceInboxTopicSelected(entry.key.topicId, input.allowedTopicIds)));
        let scanned = input.typeIds.length - states.filter((state) => isExcluded(state.entries[0])).length;
        const active = new Set(states.filter((state) => state.entries.length > 0));
        while (scanned < input.maxToScan && active.size > 0) {
            const selected = [...active].reduce(earlierFairnessReadState);
            const next = await readNextFairnessStoredQueueEntries({
                index,
                typeId: selected.typeId,
                overdueBeforeEpochMs: input.overdueBeforeEpochMs,
                after: selected.entries.at(-1)
            });
            if (next.length === 0) {
                scanned += 1;
                active.delete(selected);
                continue;
            }
            scanned += isExcluded(next[0]) ? 0 : 1;
            selected.entries.push(next[0]);
        }
        return new Map(states.map((state) => [state.typeId, state.entries.filter((entry) => !isExcluded(entry))]));
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
