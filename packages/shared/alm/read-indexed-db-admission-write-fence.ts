import type { IndexedDbWriteDeadline } from '../persistence/indexed-db-request.ts';
import { toError } from '../resilience/to-error.ts';
import type {
    IndexedDbAdmissionFence,
    IndexedDbAdmissionObservedRow
} from './indexed-db-admission-fence.ts';
import {
    isIndexedDbAdmissionObservationUnmoved,
    toIndexedDbAdmissionObservedRow
} from './indexed-db-admission-fence.ts';
import { decodeIndexedDbAdmissionStoredRow } from './indexed-db-admission-row.ts';
import { isIndexedDbAdmissionBookkeepingKey } from './read-indexed-db-admission-snapshot.ts';

/** One fenced key with what the write phase observed there. */
type IndexedDbAdmissionRowObservation = readonly [
    key: string,
    observed: IndexedDbAdmissionObservedRow
];

/** One listed prefix with the keys that list returned to the write phase. */
type IndexedDbAdmissionPrefixObservation = readonly [
    prefix: string,
    keys: readonly string[]
];

export interface ReadIndexedDbAdmissionWriteFenceInput {
    readonly eligibility: IndexedDbWriteDeadline;
    readonly fence: IndexedDbAdmissionFence;
    readonly store: IDBObjectStore;
    /** Every re-read matched: the write may go on to its guarded removals and its mutations. */
    readonly onMatched: () => void;
    readonly onConflict: () => void;
    readonly onCorruption: (key: string, error: Error) => void;
    /** Whether the write already decided its outcome, so a re-read that lands late does nothing. */
    readonly settled: () => boolean;
}

interface IndexedDbAdmissionFenceRead {
    readonly input: ReadIndexedDbAdmissionWriteFenceInput;
    pending: number;
}

/**
 * Re-reads exactly what one write phase observed, inside the transaction that commits it: one
 * request per fenced row and one cursor walk per fenced prefix. These requests join a transaction
 * the caller already observed, so they cost no observed operation of their own, and an empty fence
 * reports its match without issuing any.
 */
export function readIndexedDbAdmissionWriteFence(input: ReadIndexedDbAdmissionWriteFenceInput): void {
    const { rows, prefixes } = input.fence;
    const read: IndexedDbAdmissionFenceRead = { input, pending: rows.size + prefixes.size };
    if (read.pending === 0) {
        input.onMatched();
        return;
    }
    for (const observation of rows) {
        const request = input.eligibility.observe(input.store.get(observation[0]));
        request.onsuccess = () => completeFencedIndexedDbAdmissionRow(read, observation, request.result);
    }
    for (const listed of prefixes) {
        readFencedIndexedDbAdmissionPrefix(read, listed);
    }
}

function completeFencedIndexedDbAdmissionRow(
    read: IndexedDbAdmissionFenceRead,
    observation: IndexedDbAdmissionRowObservation,
    result: IDBRequest['result']
): void {
    if (read.input.settled()) {
        return;
    }
    const [key, observed] = observation;
    let current: IndexedDbAdmissionObservedRow;
    try {
        current = toIndexedDbAdmissionObservedRow(
            result === undefined ? undefined : decodeIndexedDbAdmissionStoredRow(result, key)
        );
    }
    catch (error) {
        read.input.onCorruption(key, toError(error));
        return;
    }
    isIndexedDbAdmissionObservationUnmoved(observed, current)
        ? completeFencedIndexedDbAdmissionRead(read)
        : read.input.onConflict();
}

/**
 * A row added to or removed from a listed range moved the decision even though no read key did, so
 * the walk compares the keys the range returns against the ones the list carried. IndexedDB sorts
 * every non-string key before every string one, so a string prefix range holds only string keys and
 * a key of another type ends the walk.
 */
function readFencedIndexedDbAdmissionPrefix(
    read: IndexedDbAdmissionFenceRead,
    observation: IndexedDbAdmissionPrefixObservation
): void {
    const [prefix, keys] = observation;
    const request = read.input.eligibility.observe(
        read.input.store.openCursor(prefix.length === 0 ? undefined : IDBKeyRange.lowerBound(prefix))
    );
    let matched = 0;
    request.onsuccess = () => {
        if (read.input.settled()) {
            return;
        }
        const cursor = request.result;
        const key = typeof cursor?.key === 'string' ? cursor.key : undefined;
        if (key === undefined || !key.startsWith(prefix)) {
            matched === keys.length ? completeFencedIndexedDbAdmissionRead(read) : read.input.onConflict();
            return;
        }
        if (isIndexedDbAdmissionBookkeepingKey(key)) {
            cursor?.continue();
            return;
        }
        if (keys[matched] !== key) {
            read.input.onConflict();
            return;
        }
        matched += 1;
        cursor?.continue();
    };
}

function completeFencedIndexedDbAdmissionRead(read: IndexedDbAdmissionFenceRead): void {
    read.pending -= 1;
    if (read.pending === 0) {
        read.input.onMatched();
    }
}
