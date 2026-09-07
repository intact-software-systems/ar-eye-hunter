import { Temporal } from '@js-temporal/polyfill';

import { IndexedDbConnection } from '../persistence/open-indexed-db.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { decodeStoredResourceEntry, type StoredResourceEntry } from '../queuebox/indexed-db-queue-box-entry-codec.ts';
import {
    computeIndexedDbQueueGuard,
    computeIndexedDbQueuePut,
    isStoredQueueEntryExpired,
    type ComputedIndexedDbQueueMutation,
    type ComputedIndexedDbQueuePut
} from '../queuebox/indexed-db-queue-box-entry.ts';
import { readStoredQueueEntry } from '../queuebox/indexed-db-queue-box-store.ts';
import { IndexedDbQueueBox } from '../queuebox/indexed-db-queue-box.ts';
import {
    toKeyAsString,
    type Key,
    type ResourceEntry
} from '../queuebox/ResourceEntry.ts';
import { writeComputedIndexedDbQueueMutations } from '../queuebox/write-computed-indexed-db-queue-mutations.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionBackendEntry
} from './al-admission-backend.ts';
import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';
import {
    AL_ADMISSION_WORK_COMPLETED_RETENTION,
    type ALAdmissionWorkBackend,
    type ALAdmissionWorkWriteContext
} from './al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import {
    toALAdmissionStoredValue,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';
import {
    AL_ADMISSION_WORK_STORE_NAME,
    openIndexedDbAdmissionDatabase
} from './open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from './read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from './write-indexed-db-admission-mutations.ts';

export namespace IndexedDbAdmissionBackend {
    export interface Input {
        readonly dbName: string;
        readonly storeName: string;
        readonly nowMs: () => number;
        readonly newWriteToken: () => string;
    }
}

export class IndexedDbAdmissionBackend implements ALAdmissionWorkBackend {
    readonly workQueue: IndexedDbQueueBox;
    readonly #connection: IndexedDbConnection;
    readonly #storeName: string;
    readonly #nowMs: () => number;
    readonly #newWriteToken: () => string;

    constructor(input: IndexedDbAdmissionBackend.Input) {
        this.#storeName = input.storeName;
        this.#nowMs = input.nowMs;
        this.#newWriteToken = input.newWriteToken;
        this.#connection = new IndexedDbConnection(() => openIndexedDbAdmissionDatabase(input.dbName, input.storeName));
        this.workQueue = new IndexedDbQueueBox({
            now: () => Temporal.Instant.fromEpochMilliseconds(this.#nowMs()),
            connection: this.#connection,
            storeName: AL_ADMISSION_WORK_STORE_NAME,
            completedRetention: AL_ADMISSION_WORK_COMPLETED_RETENTION
        });
    }

    async ready(): Promise<void> {
        await this.#connection.open();
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const db = await this.#connection.open();
        const snapshot = await readIndexedDbAdmissionSnapshot(
            db,
            this.#storeName,
            { kind: 'key', key }
        );
        const stored = snapshot.stored[0];
        if (stored === undefined) {
            return undefined;
        }
        const [value, expired] = decodeAdmissionValue({ stored, key, decode, nowMs: this.#nowMs() });
        if (!expired) {
            return value;
        }
        await removeExpiredIndexedDbAdmissionValues({
            db,
            storeName: this.#storeName,
            expectedRevision: snapshot.revision,
            removals: [{
                kind: 'remove-if-write-token',
                key,
                expectedWriteToken: stored.writeToken
            }]
        });
        return undefined;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const db = await this.#connection.open();
        const snapshot = await readIndexedDbAdmissionSnapshot(
            db,
            this.#storeName,
            { kind: 'prefixes', prefixes: [prefix] }
        );
        const entries: ALAdmissionBackendEntry<V>[] = [];
        const expiredRemovals: IndexedDbAdmissionMutation[] = [];
        const nowMs = this.#nowMs();
        for (const row of snapshot.stored) {
            const [value, expired] = decodeAdmissionValue({ stored: row, key: row.key, decode, nowMs });
            if (expired) {
                expiredRemovals.push({
                    kind: 'remove-if-write-token',
                    key: row.key,
                    expectedWriteToken: row.writeToken
                });
                continue;
            }
            entries.push({ key: row.key, value });
        }
        if (expiredRemovals.length > 0) {
            await removeExpiredIndexedDbAdmissionValues({
                db,
                storeName: this.#storeName,
                expectedRevision: snapshot.revision,
                removals: expiredRemovals
            });
        }
        return entries;
    }

    async write<T>(
        fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs: number | null = null
    ): Promise<T> {
        const db = await this.#connection.open();
        const expectedRevision = (
            await readIndexedDbAdmissionSnapshot(db, this.#storeName, { kind: 'revision' })
        ).revision;
        const buffer = new IndexedDbAdmissionWriteBuffer({
            db,
            storeName: this.#storeName,
            nowMs: this.#nowMs,
            newWriteToken: this.#newWriteToken
        });
        const result = await fn(buffer);
        const deadline = executionExpiresAtMs === null
            ? undefined
            : { expiresAtMs: executionExpiresAtMs, nowMs: this.#nowMs };
        const committed = buffer.usedMetadata
            ? await writeIndexedDbAdmissionMutations({
                deadline,
                queueMutations: buffer.queueMutations(),
                db,
                storeName: this.#storeName,
                expectedRevision,
                mutations: buffer.mutations(),
                revisionWrite: computeIndexedDbAdmissionRevisionWrite(expectedRevision)
            })
            : await writeComputedIndexedDbQueueMutations({
                db,
                storeName: AL_ADMISSION_WORK_STORE_NAME,
                mutations: buffer.queueMutations(),
                deadline
            });
        if (!committed) {
            throw new ALAdmissionBackendConflictError('IndexedDB AL admission write conflicted');
        }
        return result;
    }
}

namespace IndexedDbAdmissionWriteBuffer {
    export interface Input {
        readonly db: IDBDatabase;
        readonly storeName: string;
        readonly nowMs: () => number;
        readonly newWriteToken: () => string;
    }
}

class IndexedDbAdmissionWriteBuffer implements ALAdmissionWorkWriteContext {
    #usedMetadata = false;
    readonly #pending = new Map<string, IndexedDbAdmissionStoredRow | undefined>();
    readonly #workObservations = new Map<string, StoredResourceEntry | undefined>();
    readonly #pendingWork = new Map<string, ComputedIndexedDbQueuePut>();
    readonly #db: IDBDatabase;
    readonly #storeName: string;
    readonly #nowMs: () => number;
    readonly #newWriteToken: () => string;

    constructor(input: IndexedDbAdmissionWriteBuffer.Input) {
        this.#db = input.db;
        this.#storeName = input.storeName;
        this.#nowMs = input.nowMs;
        this.#newWriteToken = input.newWriteToken;
    }

    get usedMetadata(): boolean {
        return this.#usedMetadata;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        this.#usedMetadata = true;
        let stored = this.#pending.get(key);
        if (!this.#pending.has(key)) {
            stored = (
                await readIndexedDbAdmissionSnapshot(
                    this.#db,
                    this.#storeName,
                    { kind: 'key', key }
                )
            ).stored[0];
        }
        if (stored === undefined) {
            return undefined;
        }
        const [value, expired] = decodeAdmissionValue({ stored, key, decode, nowMs: this.#nowMs() });
        return expired ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        this.#usedMetadata = true;
        const values = new Map<string, V>();
        const storedEntries = (
            await readIndexedDbAdmissionSnapshot(
                this.#db,
                this.#storeName,
                { kind: 'prefixes', prefixes: [prefix] }
            )
        ).stored;
        const nowMs = this.#nowMs();
        for (const row of storedEntries) {
            if (this.#pending.has(row.key)) {
                continue;
            }
            const [value, expired] = decodeAdmissionValue({ stored: row, key: row.key, decode, nowMs });
            if (!expired) {
                values.set(row.key, value);
            }
        }
        for (const [key, stored] of this.#pending) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            if (stored === undefined) {
                values.delete(key);
                continue;
            }
            const [value, expired] = decodeAdmissionValue({ stored, key, decode, nowMs });
            if (expired) {
                values.delete(key);
            }
            else {
                values.set(key, value);
            }
        }
        return [...values].map(([key, value]) => ({ key, value }));
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.#usedMetadata = true;
        this.#pending.set(key, {
            key,
            value,
            expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp),
            writeToken: this.#newWriteToken()
        });
    }

    async remove(key: string): Promise<void> {
        this.#usedMetadata = true;
        this.#pending.set(key, undefined);
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const stored = this.#pendingWork.get(keyString)?.value ?? await this.readStoredWork(keyString);
        return stored === undefined ||
                isStoredQueueEntryExpired(stored, Temporal.Instant.fromEpochMilliseconds(this.#nowMs()))
            ? undefined
            : decodeStoredResourceEntry(stored);
    }

    writeWork(entry: ResourceEntry): void {
        const keyString = toKeyAsString(entry.key);
        if (!this.#workObservations.has(keyString) || this.#pendingWork.has(keyString)) {
            throw new TypeError('Admission work requires one write after its slot has been read');
        }
        const stored = this.#workObservations.get(keyString);
        this.#pendingWork.set(keyString, computeIndexedDbQueuePut(stored, entry));
    }

    queueMutations(): readonly ComputedIndexedDbQueueMutation[] {
        return [...this.#workObservations].map(([key, stored]) =>
            this.#pendingWork.get(key) ?? computeIndexedDbQueueGuard(key, stored)
        );
    }

    private async readStoredWork(keyString: string): Promise<StoredResourceEntry | undefined> {
        if (!this.#workObservations.has(keyString)) {
            this.#workObservations.set(
                keyString,
                await readStoredQueueEntry(this.#db, AL_ADMISSION_WORK_STORE_NAME, keyString)
            );
        }
        return this.#workObservations.get(keyString);
    }

    mutations(): readonly IndexedDbAdmissionMutation[] {
        return [...this.#pending].map(([key, stored]) =>
            stored === undefined ? { kind: 'remove', key } : { kind: 'set', stored }
        );
    }
}

interface DecodeAdmissionValueInput<V> {
    readonly stored: IndexedDbAdmissionStoredRow;
    readonly key: string;
    readonly decode: ALAdmissionDecoder<V>;
    readonly nowMs: number;
}

function decodeAdmissionValue<V>(input: DecodeAdmissionValueInput<V>): readonly [value: V, expired: boolean] {
    const canonical = decodeALAdmissionValue(
        toALAdmissionStoredValue(input.stored),
        input.key,
        decodeALAdmissionStoredValue
    );
    const value = decodeALAdmissionValue(canonical.value, input.key, input.decode);
    return [value, canonical.expireAtTimestamp <= input.nowMs];
}

interface RemoveExpiredIndexedDbAdmissionValuesInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly removals: readonly IndexedDbAdmissionMutation[];
    readonly storeName: string;
}

async function removeExpiredIndexedDbAdmissionValues(
    input: RemoveExpiredIndexedDbAdmissionValuesInput
): Promise<void> {
    const committed = await writeIndexedDbAdmissionMutations({
        queueMutations: [],
        db: input.db,
        storeName: input.storeName,
        expectedRevision: input.expectedRevision,
        mutations: input.removals,
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(input.expectedRevision)
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('IndexedDB AL admission expiry cleanup conflicted');
    }
}
