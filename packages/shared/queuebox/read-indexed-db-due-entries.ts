import { readIndexedDbRequest, readIndexedDbTransaction } from '../persistence/indexed-db-request.ts';
import {
    decodeStoredResourceEntry,
    decodeStoredResourceEntryValue,
    type StoredResourceEntry
} from './indexed-db-queue-box-entry-codec.ts';
import { isResourceInboxTopicSelected } from './resource-inbox/is-resource-inbox-topic-selected.ts';
import { compareResourceEntriesByDue } from './resource-inbox/resource-inbox-claim-order.ts';
import { EntityStatus } from './ResourceEntry.ts';

/** Rows one step reads at most, however large the bound a claim gives it. */
const INDEXED_DB_DUE_READ_PAGE_SIZE = 256;

interface ReadNextIndexedDbDueEntriesInput {
    /** `by-type-status-next-key`: a row with a next time, keyed by type, status, next time and key. */
    readonly index: IDBIndex;
    readonly typeId: string;
    readonly status: EntityStatus;
    readonly dueAtOrBeforeEpochMs: number;
    readonly maxToRead: number;
    /** The last row the caller read; absent, the read starts at the earliest row. */
    readonly after: StoredResourceEntry | undefined;
}

interface ReadIndexedDbDueEntriesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly indexName: string;
    readonly typeIds: Iterable<string>;
    readonly statusIds: Iterable<EntityStatus>;
    readonly dueAtOrBeforeEpochMs: number;
    readonly maxToReadPerCombination: number;
    /** Absent permits every topic; a row of another topic is read past, uncounted, and not returned. */
    readonly allowedTopicIds: ReadonlySet<string> | undefined;
    /** A row this refuses is returned but read past without counting against the bound. */
    readonly isCounted: (stored: StoredResourceEntry) => boolean;
}

interface IndexedDbDueCombinationRead {
    readonly index: IDBIndex;
    readonly typeId: string;
    readonly status: EntityStatus;
}

/** The rows of one type and status in due order, from the start or after a row already read. */
export async function readNextIndexedDbDueEntries(
    input: ReadNextIndexedDbDueEntriesInput
): Promise<StoredResourceEntry[]> {
    const lower = input.after === undefined
        ? [input.typeId, input.status, -Infinity]
        : [input.typeId, input.status, input.after.fairnessDueEpochMs!, input.after.keyString];
    const values = await readIndexedDbRequest(input.index.getAll(
        IDBKeyRange.bound(
            lower,
            [input.typeId, input.status, input.dueAtOrBeforeEpochMs, '￿'],
            input.after !== undefined
        ),
        input.maxToRead
    ));
    return values.map(decodeStoredResourceEntryValue);
}

/**
 * A due claim's candidates: at most `maxToReadPerCombination` counted rows of each type and status, due at or before
 * the bound, from one readonly transaction, merged in due order. Only due rows are read, so none hides another.
 */
export async function readIndexedDbDueEntries(
    input: ReadIndexedDbDueEntriesInput
): Promise<readonly StoredResourceEntry[]> {
    const combinations = [...input.typeIds].flatMap((typeId) =>
        [...input.statusIds].map((status) => ({ typeId, status }))
    );
    if (combinations.length === 0 || input.allowedTopicIds?.size === 0) {
        return [];
    }
    const transaction = input.db.transaction(input.storeName, 'readonly');
    const pages = await readIndexedDbTransaction(transaction, async () => {
        const index = transaction.objectStore(input.storeName).index(input.indexName);
        return await Promise.all(
            combinations.map((combination) => readIndexedDbDueCombination({ index, ...combination }, input))
        );
    });
    return toDueOrderedEntries(pages.flat());
}

async function readIndexedDbDueCombination(
    combination: IndexedDbDueCombinationRead,
    input: ReadIndexedDbDueEntriesInput
): Promise<readonly StoredResourceEntry[]> {
    const entries: StoredResourceEntry[] = [];
    let counted = 0;
    let after: StoredResourceEntry | undefined = undefined;
    while (counted < input.maxToReadPerCombination) {
        const maxToRead = Math.min(input.maxToReadPerCombination - counted, INDEXED_DB_DUE_READ_PAGE_SIZE);
        const page = await readNextIndexedDbDueEntries({
            ...combination,
            dueAtOrBeforeEpochMs: input.dueAtOrBeforeEpochMs,
            maxToRead,
            after
        });
        const selected = page.filter((stored) =>
            isResourceInboxTopicSelected(stored.key.topicId, input.allowedTopicIds)
        );
        entries.push(...selected);
        counted += selected.filter(input.isCounted).length;
        if (page.length < maxToRead) {
            break;
        }
        after = page.at(-1);
    }
    return entries;
}

/** A stable sort, so rows that tie keep the order they were read in. */
function toDueOrderedEntries(entries: readonly StoredResourceEntry[]): readonly StoredResourceEntry[] {
    return entries
        .map((stored) => ({ stored, entry: decodeStoredResourceEntry(stored) }))
        .sort((left, right) => compareResourceEntriesByDue(left.entry, right.entry))
        .map(({ stored }) => stored);
}

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
            entries: await readNextIndexedDbDueEntries({
                index,
                typeId,
                status: EntityStatus.RETRY,
                dueAtOrBeforeEpochMs: input.overdueBeforeEpochMs,
                maxToRead: 1,
                after: undefined
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
            const next = await readNextIndexedDbDueEntries({
                index,
                typeId: selected.typeId,
                status: EntityStatus.RETRY,
                dueAtOrBeforeEpochMs: input.overdueBeforeEpochMs,
                maxToRead: 1,
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
