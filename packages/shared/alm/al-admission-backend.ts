import type { Unsubscribe } from '../cache/RepositoryInterfaces.ts';
import { requireLivePersistenceWrite } from '../persistence/persistence-write-deadline.ts';
import { InMemoryQueueBox } from '../queuebox/in-memory-queue-box.ts';
import type { Key, ResourceEntry } from '../queuebox/ResourceEntry.ts';

import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber, decodeALAdmissionRecord } from './al-admission-value-validation.ts';
import {
    AL_ADMISSION_WORK_COMPLETED_RETENTION,
    type ALAdmissionReadSession,
    type ALAdmissionWorkBackend,
    type ALAdmissionWorkWriteContext
} from './al-admission-work-backend.ts';
import { ALAdmissionBackendConflictError } from './ALAdmissionBackendConflictError.ts';
import { InMemoryAdmissionWorkWriteBuffer } from './storage/in-memory-admission-work-write-buffer.ts';

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

/** A write belongs to its shared memory state even when a second backend wrapper queued it. */
const pendingWritesByState = new WeakMap<ALAdmissionMemoryState, number>();

/** Admission-time proof follows the exact volatile row and cannot survive replacement or replay. */
const terminalVolatileRowsByState = new WeakMap<ALAdmissionMemoryState, WeakSet<ALAdmissionStoredValue>>();

export interface ALAdmissionBackendEntry<V> {
    readonly key: string;
    readonly value: V;
}

/** What every admission reader offers, whether it reads the store directly or inside a transaction. */
export interface ALAdmissionReadContext {
    read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined>;
    list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]>;
}

export interface ALAdmissionBackend extends ALAdmissionReadContext {
    ready(): Promise<void>;
    write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>, executionExpiresAtMs?: number | null): Promise<T>;
}

export interface ALAdmissionWriteContext extends ALAdmissionReadContext {
    set<V>(key: string, value: V, expireAtTimestamp?: number): Promise<void>;
    remove(key: string): Promise<void>;
}

export function createInMemoryALAdmissionState(workQueue = new InMemoryQueueBox()): ALAdmissionMemoryState {
    return {
        data: new Map<string, ALAdmissionStoredValue>(),
        workQueue,
        writeTail: Promise.resolve()
    };
}

export class InMemoryAdmissionBackend implements ALAdmissionWorkBackend {
    readonly workQueue: InMemoryQueueBox;
    private readonly state: ALAdmissionMemoryState;
    private readonly nowMs: () => number;
    private readonly terminalVolatileRows: WeakSet<ALAdmissionStoredValue>;
    private readonly changeListeners = new Set<(key: string) => void>();

    constructor(
        state: ALAdmissionMemoryState,
        nowMs: () => number
    ) {
        this.state = state;
        this.terminalVolatileRows = terminalVolatileRowsByState.get(state) ?? new WeakSet<ALAdmissionStoredValue>();
        terminalVolatileRowsByState.set(state, this.terminalVolatileRows);
        this.workQueue = state.workQueue;
        this.workQueue.retainCompletedUntilExpiry(AL_ADMISSION_WORK_COMPLETED_RETENTION);
        this.nowMs = nowMs;
    }

    async ready(): Promise<void> {
    }

    /** Names, in the turn it happens, every admission key a write sets or removes or an expiry removes. */
    onChangeDo(listener: (key: string) => void): Unsubscribe {
        this.changeListeners.add(listener);
        return { unsubscribe: () => this.changeListeners.delete(listener) };
    }

    /** The row as held now, expired or not; unlike `read` it removes nothing. */
    peek(key: string): ALAdmissionStoredValue | undefined {
        return this.state.data.get(key);
    }

    /** Every key held now, expired or not; unlike `list` it removes nothing. */
    peekKeys(): readonly string[] {
        return [...this.state.data.keys()];
    }

    isTerminalVolatileRow(row: ALAdmissionStoredValue): boolean {
        return this.terminalVolatileRows.has(row);
    }

    /** Removes an observed ownership group atomically, before notifying listeners that may enqueue new work. */
    removeObservedRowsIfNoWrites(observed: readonly ALAdmissionStoredValue[]): boolean {
        if (
            (pendingWritesByState.get(this.state) ?? 0) !== 0 ||
            observed.some((row) => this.state.data.get(row.key) !== row)
        ) {
            return false;
        }
        for (const row of observed) {
            this.state.data.delete(row.key);
            this.terminalVolatileRows.delete(row);
        }
        for (const row of observed) {
            this.notifyChange(row.key);
        }
        return true;
    }

    /** The lazy expiry `read` and `list` apply, run over the whole pair; the owning lane calls it. */
    evictExpired(): void {
        const nowMs = this.nowMs();
        for (const [key, stored] of this.state.data) {
            if (stored.expireAtTimestamp <= nowMs) {
                this.deleteStored(key);
            }
        }
        this.workQueue.cleanup();
    }

    /**
     * The map holds no snapshot to keep open, so the backend is its own read session. It returns the
     * chain's own promise rather than awaiting it: a session must not cost a caller an extra turn.
     */
    readWithin<T>(read: (session: ALAdmissionReadSession) => Promise<T>): Promise<T> {
        return read(this);
    }

    async readWork(key: Key): Promise<ResourceEntry | undefined> {
        return await this.workQueue.getItem(key);
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const value = this.state.data.get(key);
        if (value === undefined) {
            return undefined;
        }
        const stored = decodeALAdmissionValue(value, key, decodeALAdmissionStoredValue);
        const decoded = decodeALAdmissionValue(stored.value, key, decode);

        if (stored.expireAtTimestamp <= this.nowMs()) {
            this.deleteStored(key);
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
                this.deleteStored(key);
                continue;
            }

            entries.push({
                key,
                value: decoded
            });
        }

        return entries;
    }

    async write<T>(
        fn: (tx: ALAdmissionWorkWriteContext) => Promise<T>,
        executionExpiresAtMs: number | null = null
    ): Promise<T> {
        pendingWritesByState.set(this.state, (pendingWritesByState.get(this.state) ?? 0) + 1);
        const previous = this.state.writeTail;
        let release: (() => void) | undefined;
        this.state.writeTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        try {
            await previous;
            const pending = new InMemoryAdmissionWorkWriteBuffer(this, this.nowMs, this.workQueue);
            const result = await fn(pending);
            const mutations = pending.mutations();
            const queueWrites = pending.queueWrites();
            requireLivePersistenceWrite(executionExpiresAtMs, this.nowMs());
            if (!this.workQueue.writeIfAllObserved(queueWrites)) {
                throw new ALAdmissionBackendConflictError('In-memory AL admission work write conflicted');
            }
            for (const row of pending.terminalVolatileRows()) {
                this.terminalVolatileRows.add(row);
            }
            for (const [key, stored] of mutations) {
                if (stored === undefined) {
                    this.deleteStored(key);
                }
                else {
                    this.setStored(key, stored);
                }
            }
            return result;
        }
        finally {
            const remaining = (pendingWritesByState.get(this.state) ?? 1) - 1;
            pendingWritesByState.set(this.state, remaining);
            release?.();
        }
    }

    /** Rows a checkpoint saved: a key the pair already holds keeps its own value. */
    loadIfAbsent(rows: readonly ALAdmissionStoredValue[], entries: readonly ResourceEntry[]): void {
        for (const row of rows) {
            if (!this.state.data.has(row.key)) {
                this.setStored(row.key, row);
            }
        }
        for (const entry of entries) {
            this.workQueue.writeIfAllObserved([{ expected: undefined, entry }]);
        }
    }

    private setStored(key: string, stored: ALAdmissionStoredValue): void {
        const previous = this.state.data.get(key);
        if (previous !== undefined && previous !== stored) {
            this.terminalVolatileRows.delete(previous);
        }
        this.state.data.set(key, stored);
        this.notifyChange(key);
    }

    private deleteStored(key: string): void {
        const row = this.state.data.get(key);
        if (row !== undefined) {
            this.terminalVolatileRows.delete(row);
        }
        if (this.state.data.delete(key)) {
            this.notifyChange(key);
        }
    }

    private notifyChange(key: string): void {
        for (const listener of this.changeListeners) {
            listener(key);
        }
    }
}

export function decodeALAdmissionStoredValue(value: unknown, key: string): ALAdmissionStoredValue {
    const record = decodeALAdmissionRecord(value, ['key', 'value', 'expireAtTimestamp']);
    if (record.key !== key) {
        throw new TypeError('Stored admission envelope belongs to another key');
    }
    return { key, value: record.value, expireAtTimestamp: decodeALAdmissionNumber(record.expireAtTimestamp) };
}
