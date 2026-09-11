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

/** The resume position of a terminal-sweep page; `by-status-end` rows always carry both fields. */
interface CompletedStoredQueueEntryCursor {
    readonly endEpochMs: number;
    readonly keyString: string;
}

interface ReadCompletedStoredQueueEntriesAtOrBeforeInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly status: EntityStatus;
    readonly endAtOrBeforeEpochMs: number;
    readonly maxToRead: number;
    readonly after?: CompletedStoredQueueEntryCursor;
}

interface ReadDeletableCompletedStoredQueueEntriesInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly statusIds: Iterable<EntityStatus>;
    readonly endAtOrBeforeEpochMs: number;
    readonly maxToDelete: number;
    readonly maxPages: number;
    readonly isDeletable: (stored: StoredResourceEntry) => boolean;
}

interface ReadDeletableCompletedStoredQueueEntriesForStatusInput {
    readonly db: IDBDatabase;
    readonly storeName: string;
    readonly status: EntityStatus;
    readonly endAtOrBeforeEpochMs: number;
    readonly maxToDelete: number;
    readonly maxPages: number;
    readonly isDeletable: (stored: StoredResourceEntry) => boolean;
}

interface DeletableCompletedStoredQueueEntryScan {
    readonly deletable: readonly StoredResourceEntry[];
    readonly pagesRead: number;
}

export const INDEXED_DB_QUEUE_FAIRNESS_INDEX_NAME = 'by-type-status-next-key';
const INDEXED_DB_QUEUE_WORK_INDEX_NAME = 'by-type-status-key';
const INDEXED_DB_QUEUE_EXPIRY_INDEX_NAME = 'by-expiry';
const INDEXED_DB_QUEUE_STATUS_END_INDEX_NAME = 'by-status-end';
/** Rows read per terminal-sweep page; the caller budgets how many pages and deletions one run gets. */
const INDEXED_DB_QUEUE_COMPLETED_SWEEP_PAGE_SIZE = 256;

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
                keyPath: ['status', 'endEpochMs', 'keyString'],
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
    const [page] = await readStoredQueueWorkPages(db, storeName, [request]);
    return page;
}

/**
 * Every request is answered exactly as a single-page read would, from one readonly transaction, so a
 * readiness scan across statuses and work types costs one round trip over one store snapshot.
 */
export async function readStoredQueueWorkPages(
    db: IDBDatabase,
    storeName: string,
    requests: readonly ResourceInboxWorkPage.Request[]
): Promise<readonly (readonly StoredResourceEntry[])[]> {
    if (requests.length === 0) {
        return [];
    }
    const transaction = db.transaction(storeName, 'readonly');
    const pages = await readIndexedDbTransaction(transaction, async () => {
        const index = transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_WORK_INDEX_NAME);
        return await Promise.all(
            requests.map((request) =>
                readIndexedDbRequest(index.getAll(toStoredQueueWorkPageRange(request), request.maxToRead))
            )
        );
    });
    return pages.map((values) => values.map(decodeStoredResourceEntryValue));
}

function toStoredQueueWorkPageRange(request: ResourceInboxWorkPage.Request): IDBKeyRange {
    const lower = request.cursor === null
        ? [request.typeId, request.status]
        : [request.typeId, request.status, request.cursor.position];
    return IDBKeyRange.bound(lower, [request.typeId, request.status, []], request.cursor !== null, true);
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
                keyStrings.map((key) => readStoredQueueEntryWithin(store, key))
            )
    );
    const entries = new Map<ResourceEntryKeyString, StoredResourceEntry>();
    for (const [index, entry] of stored.entries()) {
        if (entry !== undefined) {
            entries.set(keyStrings[index], entry);
        }
    }
    return entries;
}

/** One queue row from a store the caller already opened, so a session read joins its transaction. */
export async function readStoredQueueEntryWithin(
    store: IDBObjectStore,
    keyString: ResourceEntryKeyString
): Promise<StoredResourceEntry | undefined> {
    const value = await readIndexedDbRequest(store.get(keyString));
    if (value === undefined) {
        return undefined;
    }
    const entry = decodeStoredResourceEntryValue(value);
    if (entry.keyString !== keyString) {
        throw new TypeError('IndexedDB queue lookup returned a row for another key');
    }
    return entry;
}

/**
 * The candidate-gathering read for reservation: callers keep one flat list plus their unchanged
 * per-row predicate loop. Every typeId x status page is read from one readonly transaction, so a
 * claim over several work types costs one transaction rather than one per combination, and every
 * page in it observes the same store snapshot.
 */
export async function readStoredQueueEntriesByTypesAndStatuses(
    input: ReadStoredQueueEntriesByTypesAndStatusesInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, typeIds, statusIds, maxToReadPerCombination } = input;
    const combinations = [...typeIds].flatMap((typeId) => [...statusIds].map((status) => ({ typeId, status })));
    if (combinations.length === 0) {
        return [];
    }
    const transaction = db.transaction(storeName, 'readonly');
    const pages = await readIndexedDbTransaction(transaction, async () => {
        const index = transaction.objectStore(storeName).index(INDEXED_DB_QUEUE_WORK_INDEX_NAME);
        return await Promise.all(combinations.map(({ typeId, status }) =>
            readIndexedDbRequest(
                index.getAll(IDBKeyRange.bound([typeId, status], [typeId, status, []]), maxToReadPerCombination)
            )
        ));
    });
    return pages.flat().map(decodeStoredResourceEntryValue);
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

/** One page of terminal rows ordered by end timestamp then key, resuming after the cursor row. */
async function readCompletedStoredQueueEntriesAtOrBefore(
    input: ReadCompletedStoredQueueEntriesAtOrBeforeInput
): Promise<readonly StoredResourceEntry[]> {
    const { db, storeName, status, endAtOrBeforeEpochMs, maxToRead, after } = input;
    const lower = after === undefined
        ? [status, Number.MIN_SAFE_INTEGER, '']
        : [status, after.endEpochMs, after.keyString];
    const range = IDBKeyRange.bound(
        lower,
        [status, endAtOrBeforeEpochMs, []],
        after !== undefined
    );
    const transaction = db.transaction(storeName, 'readonly');
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

/** A row read back from `by-status-end` is indexed by its end timestamp, so a null one is corrupt. */
function toCompletedStoredQueueEntryCursor(stored: StoredResourceEntry): CompletedStoredQueueEntryCursor {
    if (stored.endEpochMs === null) {
        throw new TypeError('IndexedDB terminal sweep row carries no end timestamp');
    }
    return { endEpochMs: stored.endEpochMs, keyString: stored.keyString };
}

async function readDeletableCompletedStoredQueueEntriesForStatus(
    input: ReadDeletableCompletedStoredQueueEntriesForStatusInput
): Promise<DeletableCompletedStoredQueueEntryScan> {
    const deletable: StoredResourceEntry[] = [];
    let after: CompletedStoredQueueEntryCursor | undefined = undefined;
    let pagesRead = 0;
    while (deletable.length < input.maxToDelete && pagesRead < input.maxPages) {
        const page = await readCompletedStoredQueueEntriesAtOrBefore({
            db: input.db,
            storeName: input.storeName,
            status: input.status,
            endAtOrBeforeEpochMs: input.endAtOrBeforeEpochMs,
            maxToRead: INDEXED_DB_QUEUE_COMPLETED_SWEEP_PAGE_SIZE,
            after
        });
        pagesRead += 1;
        for (const stored of page) {
            if (deletable.length < input.maxToDelete && input.isDeletable(stored)) {
                deletable.push(stored);
            }
        }
        if (page.length < INDEXED_DB_QUEUE_COMPLETED_SWEEP_PAGE_SIZE) {
            break;
        }
        after = toCompletedStoredQueueEntryCursor(page[page.length - 1]);
    }
    return { deletable, pagesRead };
}

/**
 * Rows the caller keeps never consume the deletion budget, so a terminal status crowded with
 * retained rows cannot starve the sweep: paging continues past them until maxToDelete deletable
 * rows are collected, the range is exhausted, or the run's page budget is spent.
 */
export async function readDeletableCompletedStoredQueueEntries(
    input: ReadDeletableCompletedStoredQueueEntriesInput
): Promise<readonly StoredResourceEntry[]> {
    const deletable: StoredResourceEntry[] = [];
    let remainingPages = input.maxPages;
    for (const status of input.statusIds) {
        if (deletable.length >= input.maxToDelete || remainingPages <= 0) {
            break;
        }
        const scan = await readDeletableCompletedStoredQueueEntriesForStatus({
            db: input.db,
            storeName: input.storeName,
            status,
            endAtOrBeforeEpochMs: input.endAtOrBeforeEpochMs,
            maxToDelete: input.maxToDelete - deletable.length,
            maxPages: remainingPages,
            isDeletable: input.isDeletable
        });
        deletable.push(...scan.deletable);
        remainingPages -= scan.pagesRead;
    }
    return deletable;
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
