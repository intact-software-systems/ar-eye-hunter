import { IndexedDbConnection } from '../persistence/open-indexed-db.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionBackend,
    type ALAdmissionBackendEntry,
    type ALAdmissionWriteContext
} from './al-admission-backend.ts';
import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import {
    toALAdmissionStoredValue,
    type IndexedDbAdmissionStoredRow
} from './indexed-db-admission-row.ts';
import {
    openIndexedDbAdmissionDatabase
} from './open-indexed-db-admission-database.ts';
import { readIndexedDbAdmissionSnapshot } from './read-indexed-db-admission-snapshot.ts';
import {
    computeIndexedDbAdmissionRevisionWrite,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from './write-indexed-db-admission-mutations.ts';

export class IndexedDbAdmissionBackend implements ALAdmissionBackend {
    readonly #browserLocks: LockManager | undefined;
    readonly #connection: IndexedDbConnection;
    readonly #storeName: string;
    readonly #nowMs: () => number;
    readonly #writeLockName: string;

    constructor(
        dbName: string,
        storeName: string,
        nowMs: () => number
    ) {
        this.#browserLocks = typeof globalThis.navigator?.locks?.request === 'function'
            ? globalThis.navigator.locks
            : undefined;
        this.#storeName = storeName;
        this.#nowMs = nowMs;
        this.#writeLockName = `rallar:indexed-db-admission:${dbName}:${storeName}`;
        this.#connection = new IndexedDbConnection(() => openIndexedDbAdmissionDatabase(dbName, storeName));
    }

    async ready(): Promise<void> {
        await this.#connection.get();
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const db = await this.#connection.get();
        const snapshot = await readIndexedDbAdmissionSnapshot(
            db,
            this.#storeName,
            { kind: 'key', key }
        );
        const stored = snapshot.stored[0];
        if (stored === undefined) {
            return undefined;
        }
        const [value, expired] = decodeAdmissionValue(stored, key, decode, this.#nowMs());
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
        const db = await this.#connection.get();
        const snapshot = await readIndexedDbAdmissionSnapshot(
            db,
            this.#storeName,
            { kind: 'prefixes', prefixes: [prefix] }
        );
        const entries: ALAdmissionBackendEntry<V>[] = [];
        const expiredRemovals: IndexedDbAdmissionMutation[] = [];
        const nowMs = this.#nowMs();
        for (const row of snapshot.stored) {
            const [value, expired] = decodeAdmissionValue(row, row.key, decode, nowMs);
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

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const locks = this.#browserLocks;
        if (!locks) {
            return await this.#writeNow(fn);
        }
        return await locks.request(
            this.#writeLockName,
            { mode: 'exclusive' },
            () => this.#writeNow(fn)
        );
    }

    async #writeNow<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.#connection.get();
        const expectedRevision = (
            await readIndexedDbAdmissionSnapshot(db, this.#storeName, { kind: 'revision' })
        ).revision;
        const buffer = new IndexedDbAdmissionWriteBuffer(db, this.#storeName, this.#nowMs);
        const result = await fn(buffer);
        const mutations = buffer.mutations();
        const committed = await writeIndexedDbAdmissionMutations({
            db,
            storeName: this.#storeName,
            expectedRevision,
            mutations,
            revisionWrite: computeIndexedDbAdmissionRevisionWrite(expectedRevision)
        });
        if (!committed) {
            throw new ALAdmissionBackendConflictError('IndexedDB AL admission write conflicted');
        }
        return result;
    }
}

class IndexedDbAdmissionWriteBuffer implements ALAdmissionWriteContext {
    readonly #pending = new Map<string, IndexedDbAdmissionStoredRow | undefined>();
    readonly #db: IDBDatabase;
    readonly #storeName: string;
    readonly #nowMs: () => number;

    constructor(db: IDBDatabase, storeName: string, nowMs: () => number) {
        this.#db = db;
        this.#storeName = storeName;
        this.#nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
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
        const [value, expired] = decodeAdmissionValue(stored, key, decode, this.#nowMs());
        return expired ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
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
            const [value, expired] = decodeAdmissionValue(row, row.key, decode, nowMs);
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
            const [value, expired] = decodeAdmissionValue(stored, key, decode, nowMs);
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
        this.#pending.set(key, {
            key,
            value,
            expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp),
            writeToken: crypto.randomUUID()
        });
    }

    async remove(key: string): Promise<void> {
        this.#pending.set(key, undefined);
    }

    mutations(): readonly IndexedDbAdmissionMutation[] {
        return [...this.#pending].map(([key, stored]) =>
            stored === undefined ? { kind: 'remove', key } : { kind: 'set', stored }
        );
    }
}

function decodeAdmissionValue<V>(
    stored: IndexedDbAdmissionStoredRow,
    key: string,
    decode: ALAdmissionDecoder<V>,
    nowMs: number
): readonly [value: V, expired: boolean] {
    const canonical = decodeALAdmissionValue(
        toALAdmissionStoredValue(stored),
        key,
        decodeALAdmissionStoredValue
    );
    const value = decodeALAdmissionValue(canonical.value, key, decode);
    return [value, canonical.expireAtTimestamp <= nowMs];
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
