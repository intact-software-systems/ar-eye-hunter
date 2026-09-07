import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { InMemoryQueueBox } from '../queuebox/in-memory-queue-box.ts';
import { toResourceEntrySnapshot } from '../queuebox/resource-entry-observations.ts';
import { toKeyAsString, toResourceEntryKey, type Key, type ResourceEntry } from '../queuebox/ResourceEntry.ts';

import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber, decodeALAdmissionRecord } from './al-admission-value-validation.ts';
import type { ALAdmissionWorkBackend, ALAdmissionWorkWriteContext } from './al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';

export interface ALAdmissionStoredValue {
    readonly key: string;
    readonly value: unknown;
    readonly expireAtTimestamp: number;
}

export interface ALAdmissionMemoryState {
    readonly data: Map<string, ALAdmissionStoredValue>;
    readonly workQueue: InMemoryQueueBox;
    writeTail: Promise<void>;
}

export interface ALAdmissionBackendEntry<V> {
    readonly key: string;
    readonly value: V;
}

export interface ALAdmissionBackend {
    ready(): Promise<void>;
    read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined>;
    list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]>;
    write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T>;
}

export interface ALAdmissionWriteContext {
    read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined>;
    list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]>;
    set<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
    remove(key: string): Promise<void>;
}

export function createInMemoryALAdmissionState(): ALAdmissionMemoryState {
    return {
        data: new Map<string, ALAdmissionStoredValue>(),
        workQueue: new InMemoryQueueBox(),
        writeTail: Promise.resolve()
    };
}

export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
    readonly workQueue: InMemoryQueueBox;
    private readonly state: ALAdmissionMemoryState;
    private readonly nowMs: () => number;

    constructor(
        state: ALAdmissionMemoryState,
        nowMs: () => number
    ) {
        this.state = state;
        this.workQueue = state.workQueue;
        this.nowMs = nowMs;
    }

    async ready(): Promise<void> {
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const value = this.state.data.get(key);
        if (value === undefined) {
            return undefined;
        }
        const stored = decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
        const decoded = decodeALAdmissionValue(stored.value, key, decode);

        if (stored.expireAtTimestamp <= this.nowMs()) {
            this.state.data.delete(key);
            return undefined;
        }

        return decoded;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const entries: ALAdmissionBackendEntry<V>[] = [];

        for (const [key, value] of this.state.data.entries()) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            const stored = decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
            const decoded = decodeALAdmissionValue(stored.value, key, decode);

            if (stored.expireAtTimestamp <= this.nowMs()) {
                this.state.data.delete(key);
                continue;
            }

            entries.push({
                key,
                value: decoded
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>): Promise<T> {
        const previous = this.state.writeTail;
        let release: (() => void) | undefined;
        this.state.writeTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            const pending = new InMemoryAdmissionWorkWriteBuffer(this, this.nowMs, this.workQueue);
            const result = await fn(pending);
            const mutations = pending.mutations();
            const queueWrites = pending.queueWrites();
            if (!this.workQueue.writeIfAllObserved(queueWrites)) {
                throw new ALAdmissionBackendConflictError('In-memory AL admission work write conflicted');
            }
            for (const [key, stored] of mutations) {
                stored === undefined ? this.state.data.delete(key) : this.state.data.set(key, stored);
            }
            return result;
        }
        finally {
            release?.();
        }
    }
}

class ALAdmissionWriteBuffer implements ALAdmissionWriteContext {
    private readonly pending = new Map<string, ALAdmissionStoredValue | undefined>();
    private readonly storage: Pick<ALAdmissionBackend, 'read' | 'list'>;
    private readonly nowMs: () => number;

    constructor(storage: Pick<ALAdmissionBackend, 'read' | 'list'>, nowMs: () => number) {
        this.storage = storage;
        this.nowMs = nowMs;
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        if (!this.pending.has(key)) {
            return await this.storage.read(key, decode);
        }
        const stored = this.pending.get(key);
        if (!stored) {
            return undefined;
        }
        const value = decodeALAdmissionValue(stored.value, key, decode);
        return stored.expireAtTimestamp <= this.nowMs() ? undefined : value;
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const values = new Map<string, V>();
        const entries = await this.storage.list(prefix, (value, key) =>
            this.pending.has(key)
                ? { kind: 'shadowed' as const }
                : { kind: 'decoded' as const, value: decodeALAdmissionValue(value, key, decode) });
        for (const entry of entries) {
            if (entry.value.kind === 'decoded') {
                values.set(entry.key, entry.value.value);
            }
        }
        for (const [key, stored] of this.pending) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            if (!stored) {
                values.delete(key);
                continue;
            }
            const value = decodeALAdmissionValue(stored.value, key, decode);
            if (stored.expireAtTimestamp <= this.nowMs()) {
                values.delete(key);
                continue;
            }
            values.set(key, value);
        }
        return [...values].map(([key, value]) => ({ key, value }));
    }

    async set<V>(key: string, value: V, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP): Promise<void> {
        this.pending.set(key, { key, value, expireAtTimestamp: decodeALAdmissionNumber(expireAtTimestamp) });
    }

    async remove(key: string): Promise<void> {
        this.pending.set(key, undefined);
    }

    mutations(): readonly (readonly [key: string, stored: ALAdmissionStoredValue | undefined])[] {
        return [...this.pending];
    }
}

class InMemoryAdmissionWorkWriteBuffer extends ALAdmissionWriteBuffer implements ALAdmissionWorkWriteContext {
    private readonly workQueue: InMemoryQueueBox;
    private readonly observations = new Map<string, ResourceEntry | undefined>();
    private readonly pendingWork = new Map<string, ResourceEntry>();

    constructor(storage: ALAdmissionBackend, nowMs: () => number, workQueue: InMemoryQueueBox) {
        super(storage, nowMs);
        this.workQueue = workQueue;
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        const keyString = toKeyAsString(key);
        const pending = this.pendingWork.get(keyString);
        if (pending !== undefined) {
            return toResourceEntrySnapshot(pending);
        }
        if (!this.observations.has(keyString)) {
            this.observations.set(keyString, await this.workQueue.getItem(key));
        }
        const observed = this.observations.get(keyString);
        return observed === undefined ? undefined : toResourceEntrySnapshot(observed);
    }

    writeWork(entry: ResourceEntry): void {
        const key = toKeyAsString(entry.key);
        if (!this.observations.has(key) || this.pendingWork.has(key)) {
            throw new TypeError('Admission work requires one write after its slot has been read');
        }
        this.pendingWork.set(key, toResourceEntrySnapshot(entry));
    }

    queueWrites(): readonly InMemoryQueueBox.ComputedOperation[] {
        return [...this.observations].map(([key, expected]) => {
            const entry = this.pendingWork.get(key);
            return entry === undefined ? { key: toResourceEntryKey(key), expected } : { entry, expected };
        });
    }
}

export function decodeALAdmissionStoredValue(value: unknown, key: string): ALAdmissionStoredValue {
    const record = decodeALAdmissionRecord(value, ['key', 'value', 'expireAtTimestamp']);
    if (record.key !== key) {
        throw new TypeError('Stored admission envelope belongs to another key');
    }
    return { key, value: record.value, expireAtTimestamp: decodeALAdmissionNumber(record.expireAtTimestamp) };
}
