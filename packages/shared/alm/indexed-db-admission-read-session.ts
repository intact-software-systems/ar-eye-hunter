import { Temporal } from '@js-temporal/polyfill';

import type { IndexedDbOperationObserver } from '../persistence/indexed-db-operation-observer.ts';
import { readIndexedDbRequest } from '../persistence/indexed-db-request.ts';
import {
    decodeStoredResourceEntry,
    type StoredResourceEntry
} from '../queuebox/indexed-db-queue-box-entry-codec.ts';
import { isStoredQueueEntryExpired } from '../queuebox/indexed-db-queue-box-entry.ts';
import { readStoredQueueEntryWithin } from '../queuebox/indexed-db-queue-box-store.ts';
import {
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';
import { toError } from '../resilience/to-error.ts';
import type { ALAdmissionBackendEntry } from './al-admission-backend.ts';
import type { ALAdmissionDecoder } from './al-admission-decoder.ts';
import type { ALAdmissionReadSession } from './al-admission-work-backend.ts';
import {
    decodeIndexedDbAdmissionValue,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    AL_ADMISSION_WORK_STORE_NAME,
    decodeIndexedDbAdmissionRevision
} from './open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSelection } from './read-indexed-db-admission-snapshot.ts';
import type { IndexedDbAdmissionMutation } from './write-indexed-db-admission-mutations.ts';

/** How a finished transaction refuses a request: it is no longer active, or already gone. */
const FINISHED_TRANSACTION_ERROR_NAMES: ReadonlySet<string> = new Set([
    'TransactionInactiveError',
    'InvalidStateError'
]);

interface IndexedDbAdmissionReadSnapshot {
    readonly transaction: IDBTransaction;
    readonly admission: IDBObjectStore;
    readonly work: IDBObjectStore;
}

/** The expired rows a finished chain observed, fenced by the revision the chain read them at. */
export interface ExpiredIndexedDbAdmissionRows {
    readonly expectedRevision: number;
    readonly removals: readonly IndexedDbAdmissionMutation[];
}

export namespace IndexedDbAdmissionReadSession {
    export interface Input {
        readonly db: IDBDatabase;
        readonly storeName: string;
        readonly nowMs: () => number;
        readonly observer: IndexedDbOperationObserver;
    }
}

/**
 * One readonly snapshot over the admission state store and the work-queue store, which share a
 * database. Requests issue back to back, so a whole decision surface costs one transaction; a read
 * issued after that snapshot ended continues on a fresh one, so no caller depends on it lasting.
 */
export class IndexedDbAdmissionReadSession implements ALAdmissionReadSession {
    #snapshot: IndexedDbAdmissionReadSnapshot | undefined;
    #expiredRevision: number | undefined;
    readonly #expired = new Map<string, IndexedDbAdmissionMutation>();
    readonly #db: IDBDatabase;
    readonly #storeName: string;
    readonly #nowMs: () => number;
    readonly #observer: IndexedDbOperationObserver;

    constructor(input: IndexedDbAdmissionReadSession.Input) {
        this.#db = input.db;
        this.#storeName = input.storeName;
        this.#nowMs = input.nowMs;
        this.#observer = input.observer;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        this.#observer.observe({ owner: 'al-admission', kind: 'read' });
        const stored = await this.readRow(key);
        if (stored === undefined) {
            return undefined;
        }
        const [value, expired] = decodeIndexedDbAdmissionValue({ stored, key, decode, nowMs: this.#nowMs() });
        if (!expired) {
            return value;
        }
        await this.#recordExpired(stored);
        return undefined;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        this.#observer.observe({ owner: 'al-admission', kind: 'list' });
        const nowMs = this.#nowMs();
        const entries: ALAdmissionBackendEntry<V>[] = [];
        for (const stored of await this.readRows(prefix)) {
            const [value, expired] = decodeIndexedDbAdmissionValue({ stored, key: stored.key, decode, nowMs });
            if (expired) {
                await this.#recordExpired(stored);
                continue;
            }
            entries.push({ key: stored.key, value });
        }
        return entries;
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        this.#observer.observe({ owner: 'al-work', kind: 'work-read' });
        const stored = await this.readStoredWork(toKeyAsString(key));
        return stored === undefined ||
                isStoredQueueEntryExpired(stored, Temporal.Instant.fromEpochMilliseconds(this.#nowMs()))
            ? undefined
            : decodeStoredResourceEntry(stored);
    }

    /** The stored state row, for a reader that owns its own decoding and its own pending writes. */
    async readRow(key: string): Promise<IndexedDbAdmissionStoredRow | undefined> {
        const rows = await this.#issue((snapshot) =>
            readIndexedDbAdmissionSelection(snapshot.admission, { kind: 'key', key })
        );
        return rows[0];
    }

    async readRows(prefix: string): Promise<readonly IndexedDbAdmissionStoredRow[]> {
        return await this.#issue((snapshot) =>
            readIndexedDbAdmissionSelection(snapshot.admission, { kind: 'prefixes', prefixes: [prefix] })
        );
    }

    /** The stored work row exactly as persisted: an expired slot is still the slot a write fences. */
    async readStoredWork(keyString: string): Promise<StoredResourceEntry | undefined> {
        return await this.#issue((snapshot) => readStoredQueueEntryWithin(snapshot.work, keyString));
    }

    async readRevision(): Promise<number> {
        return decodeIndexedDbAdmissionRevision(
            await this.#issue((snapshot) => readIndexedDbRequest(snapshot.admission.get(AL_ADMISSION_REVISION_KEY)))
        );
    }

    /** What the chain read past its expiry, for the caller that owns evicting it. Reported once. */
    takeExpiredRows(): ExpiredIndexedDbAdmissionRows | undefined {
        const expectedRevision = this.#expiredRevision;
        if (expectedRevision === undefined) {
            return undefined;
        }
        const removals = [...this.#expired.values()];
        this.#expired.clear();
        this.#expiredRevision = undefined;
        return { expectedRevision, removals };
    }

    /**
     * Ends the snapshot now rather than when IndexedDB next idles. A readonly transaction holds a
     * shared lock on both stores, so the write that follows a finished read chain would otherwise
     * queue behind it; there is nothing to roll back, so aborting is how a reader releases it. A
     * transaction that already finished refuses the abort, and that refusal is the state this
     * method wanted -- it must not surface as an error over one thrown from a caller's `finally`.
     */
    close(): void {
        const open = this.#snapshot;
        this.#snapshot = undefined;
        if (open === undefined) {
            return;
        }
        try {
            open.transaction.abort();
        }
        catch (error) {
            if (!FINISHED_TRANSACTION_ERROR_NAMES.has(toError(error).name)) {
                throw error;
            }
        }
    }

    /** The revision comes from the snapshot the first expired row was read at: that is its fence. */
    async #recordExpired(stored: IndexedDbAdmissionStoredRow): Promise<void> {
        this.#expired.set(stored.key, {
            kind: 'remove-if-write-token',
            key: stored.key,
            expectedWriteToken: stored.writeToken
        });
        this.#expiredRevision = this.#expiredRevision ?? await this.readRevision();
    }

    async #issue<Result>(
        request: (snapshot: IndexedDbAdmissionReadSnapshot) => Promise<Result>
    ): Promise<Result> {
        try {
            return await request(this.#openSnapshot());
        }
        catch (error) {
            if (!FINISHED_TRANSACTION_ERROR_NAMES.has(toError(error).name)) {
                throw error;
            }
            this.#snapshot = undefined;
            return await request(this.#openSnapshot());
        }
    }

    #openSnapshot(): IndexedDbAdmissionReadSnapshot {
        const existing = this.#snapshot;
        if (existing !== undefined) {
            return existing;
        }
        const transaction = this.#db.transaction([this.#storeName, AL_ADMISSION_WORK_STORE_NAME], 'readonly');
        const opened: IndexedDbAdmissionReadSnapshot = {
            transaction,
            admission: transaction.objectStore(this.#storeName),
            work: transaction.objectStore(AL_ADMISSION_WORK_STORE_NAME)
        };
        for (const ended of ['complete', 'abort', 'error']) {
            transaction.addEventListener(ended, () => {
                if (this.#snapshot === opened) {
                    this.#snapshot = undefined;
                }
            });
        }
        this.#snapshot = opened;
        return opened;
    }
}
