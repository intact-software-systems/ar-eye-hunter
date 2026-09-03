import { openIndexedDbWithStore } from '../persistence/openIndexedDb.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import {
    decodeALAdmissionStoredValue,
    type ALAdmissionBackend,
    type ALAdmissionBackendEntry,
    type ALAdmissionStoredValue,
    type ALAdmissionWriteContext
} from './al-admission-backend.ts';
import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import {
    AL_ADMISSION_REVISION_KEY,
    computeIndexedDbAdmissionRevisionWrite,
    listIndexedDbAdmissionSnapshot,
    listIndexedDbAdmissionStoredValues,
    readIndexedDbAdmissionRevision,
    readIndexedDbAdmissionSnapshot,
    readIndexedDbAdmissionStoredValue,
    writeIndexedDbAdmissionMutations,
    type IndexedDbAdmissionMutation
} from './indexed-db-admission-storage.ts';

export class IndexedDbAdmissionBackend implements ALAdmissionBackend {
    private dbPromise?: Promise<IDBDatabase>;

    private readonly dbName: string;
    private readonly storeName: string;
    private readonly nowMs: () => number;

    constructor(
        dbName: string,
        storeName: string,
        nowMs: () => number
    ) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.nowMs = nowMs;
    }

    async ready(): Promise<void> {
        await this.openDb();
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const db = await this.openDb();
        const snapshot = await readIndexedDbAdmissionSnapshot(db, this.storeName, key);
        if (snapshot.stored === undefined) {
            return undefined;
        }
        const observed = decodeAdmissionValue(snapshot.stored, key, decode, this.nowMs());
        if (!observed.expired) {
            return observed.value;
        }
        await removeExpiredIndexedDbAdmissionValues({
            db,
            storeName: this.storeName,
            expectedRevision: snapshot.revision,
            keys: [key]
        });
        return undefined;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const db = await this.openDb();
        const snapshot = await listIndexedDbAdmissionSnapshot(db, this.storeName, prefix);
        const entries: ALAdmissionBackendEntry<V>[] = [];
        const expiredKeys: string[] = [];
        const nowMs = this.nowMs();
        for (const row of snapshot.stored) {
            if (row.key === AL_ADMISSION_REVISION_KEY) {
                continue;
            }
            const observed = decodeAdmissionValue(row, row.key, decode, nowMs);
            if (observed.expired) {
                expiredKeys.push(row.key);
            }
            else {
                entries.push({ key: row.key, value: observed.value });
            }
        }
        if (expiredKeys.length > 0) {
            await removeExpiredIndexedDbAdmissionValues({
                db,
                storeName: this.storeName,
                expectedRevision: snapshot.revision,
                keys: expiredKeys
            });
        }
        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const db = await this.openDb();
        const expectedRevision = await readIndexedDbAdmissionRevision(db, this.storeName);
        const buffer = new IndexedDbAdmissionWriteBuffer(db, this.storeName, this.nowMs);
        const result = await fn(buffer);
        const mutations = buffer.mutations();
        const committed = await writeIndexedDbAdmissionMutations({
            db,
            storeName: this.storeName,
            expectedRevision,
            mutations,
            revisionWrite: computeIndexedDbAdmissionRevisionWrite(expectedRevision)
        });
        if (!committed) {
            throw new ALAdmissionBackendConflictError('IndexedDB AL admission write conflicted');
        }
        return result;
    }

    private async openDb(): Promise<IDBDatabase> {
        if (!this.dbPromise) {
            this.dbPromise = openIndexedDbWithStore(
                this.dbName,
                {
                    name: this.storeName,
                    keyPath: 'key'
                }
            ).then((db) => {
                db.onversionchange = () => {
                    db.close();
                    this.dbPromise = undefined;
                };
                return db;
            });
        }

        return await this.dbPromise;
    }
}

class IndexedDbAdmissionWriteBuffer implements ALAdmissionWriteContext {
    private readonly pending = new Map<string, ALAdmissionStoredValue | undefined>();
    private readonly db: IDBDatabase;
    private readonly storeName: string;
    private readonly nowMs: () => number;

    constructor(db: IDBDatabase, storeName: string, nowMs: () => number) {
        this.db = db;
        this.storeName = storeName;
        this.nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        if (!this.pending.has(key)) {
            const stored = await readIndexedDbAdmissionStoredValue(this.db, this.storeName, key);
            if (stored === undefined) {
                return undefined;
            }
            const observed = decodeAdmissionValue(stored, key, decode, this.nowMs());
            return observed.expired ? undefined : observed.value;
        }
        const stored = this.pending.get(key);
        if (stored === undefined) {
            return undefined;
        }
        const observed = decodeAdmissionValue(stored, key, decode, this.nowMs());
        return observed.expired ? undefined : observed.value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const values = new Map<string, V>();
        const storedEntries = await listIndexedDbAdmissionStoredValues(this.db, this.storeName, prefix);
        const nowMs = this.nowMs();
        for (const stored of storedEntries) {
            if (stored.key === AL_ADMISSION_REVISION_KEY || this.pending.has(stored.key)) {
                continue;
            }
            const observed = decodeAdmissionValue(stored, stored.key, decode, nowMs);
            if (!observed.expired) {
                values.set(stored.key, observed.value);
            }
        }
        for (const [key, stored] of this.pending) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            if (stored === undefined) {
                values.delete(key);
                continue;
            }
            const observed = decodeAdmissionValue(stored, key, decode, nowMs);
            if (observed.expired) {
                values.delete(key);
            }
            else {
                values.set(key, observed.value);
            }
        }
        return [...values].map(([key, value]) => ({ key, value }));
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.pending.set(key, {
            key,
            value,
            expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp)
        });
    }

    async remove(key: string): Promise<void> {
        this.pending.set(key, undefined);
    }

    mutations(): readonly IndexedDbAdmissionMutation[] {
        return [...this.pending].map(([key, stored]) =>
            stored === undefined ? { kind: 'remove', key } : { kind: 'set', stored }
        );
    }
}

function decodeAdmissionValue<V>(
    stored: ALAdmissionStoredValue,
    key: string,
    decode: ALAdmissionDecoder<V>,
    nowMs: number
): Readonly<{ value: V; expired: boolean; }> {
    const canonical = decodeALAdmissionValue(stored, key, decodeALAdmissionStoredValue);
    const value = decodeALAdmissionValue(canonical.value, key, decode);
    return { value, expired: canonical.expireAtTimestamp <= nowMs };
}

interface RemoveExpiredIndexedDbAdmissionValuesInput {
    readonly db: IDBDatabase;
    readonly expectedRevision: number;
    readonly keys: readonly string[];
    readonly storeName: string;
}

async function removeExpiredIndexedDbAdmissionValues(
    input: RemoveExpiredIndexedDbAdmissionValuesInput
): Promise<void> {
    const committed = await writeIndexedDbAdmissionMutations({
        db: input.db,
        storeName: input.storeName,
        expectedRevision: input.expectedRevision,
        mutations: input.keys.map((key) => ({ kind: 'remove', key })),
        revisionWrite: computeIndexedDbAdmissionRevisionWrite(input.expectedRevision)
    });
    if (!committed) {
        throw new ALAdmissionBackendConflictError('IndexedDB AL admission expiry cleanup conflicted');
    }
}
