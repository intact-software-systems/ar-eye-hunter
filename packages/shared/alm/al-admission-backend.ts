import type { PersistenceProvider } from '../persistence/PersistenceProvider.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';

import { decodeALAdmissionValue, type ALAdmissionDecoder } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber, decodeALAdmissionRecord } from './al-admission-value-validation.ts';

export interface ALAdmissionStoredValue {
    readonly key: string;
    readonly value: unknown;
    readonly expireAtTimestamp: number;
}

export interface ALAdmissionMemoryState {
    readonly data: Map<string, ALAdmissionStoredValue>;
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

const providerWriteTailByCoordinationKey = new Map<string, Promise<void>>();

export function createInMemoryALAdmissionState(): ALAdmissionMemoryState {
    return {
        data: new Map<string, ALAdmissionStoredValue>(),
        writeTail: Promise.resolve()
    };
}

export class InMemoryAdmissionBackend implements ALAdmissionBackend {
    private readonly state: ALAdmissionMemoryState;
    private readonly nowMs: () => number;

    constructor(
        state: ALAdmissionMemoryState,
        nowMs: () => number
    ) {
        this.state = state;
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

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = this.state.writeTail;
        let release: (() => void) | undefined;
        this.state.writeTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            const pending = new ALAdmissionWriteBuffer({
                read: async (key, decode) => await this.read(key, decode),
                list: async (prefix, decode) => await this.list(prefix, decode),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    this.state.data.set(
                        key,
                        {
                            key,
                            value,
                            expireAtTimestamp
                        }
                    );
                },
                remove: async (key) => {
                    this.state.data.delete(key);
                }
            }, this.nowMs);
            const result = await fn(pending);
            await pending.flush();
            return result;
        }
        finally {
            release?.();
        }
    }
}

export class PersistenceProviderAdmissionBackend implements ALAdmissionBackend {
    private readonly provider: PersistenceProvider<string, unknown>;
    private readonly coordinationKey: string;
    private readonly nowMs: () => number;

    constructor(
        provider: PersistenceProvider<string, unknown>,
        coordinationKey: string,
        nowMs: () => number
    ) {
        this.provider = provider;
        this.coordinationKey = coordinationKey;
        this.nowMs = nowMs;
    }

    async ready(): Promise<void> {
    }

    async read<V>(key: string, decode: ALAdmissionDecoder<V>): Promise<V | undefined> {
        const value = await this.provider.getItem(key);
        return value === undefined ? undefined : decodeALAdmissionValue(value, key, decode);
    }

    async list<V>(prefix: string, decode: ALAdmissionDecoder<V>): Promise<readonly ALAdmissionBackendEntry<V>[]> {
        const entries: ALAdmissionBackendEntry<V>[] = [];

        for (const key of await this.provider.getAllKeys()) {
            if (!key.startsWith(prefix)) {
                continue;
            }

            const value = await this.provider.getItem(key);
            if (value === undefined) {
                continue;
            }

            entries.push({
                key,
                value: decodeALAdmissionValue(value, key, decode)
            });
        }

        return entries;
    }

    async write<T>(fn: (tx: ALAdmissionWriteContext) => Promise<T>): Promise<T> {
        const previous = providerWriteTailByCoordinationKey.get(this.coordinationKey) ?? Promise.resolve();
        let release: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.then(() => gate);
        providerWriteTailByCoordinationKey.set(this.coordinationKey, tail);

        await previous;

        try {
            const pending = new ALAdmissionWriteBuffer({
                read: async (key, decode) => await this.read(key, decode),
                list: async (prefix, decode) => await this.list(prefix, decode),
                set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                    await this.provider.setItem(
                        key,
                        value,
                        {
                            expireAtTimestamp
                        }
                    );
                },
                remove: async (key) => {
                    await this.provider.removeItem(key);
                }
            }, this.nowMs);
            const result = await fn(pending);
            await pending.flush();
            return result;
        }
        finally {
            release?.();
            if (providerWriteTailByCoordinationKey.get(this.coordinationKey) === tail) {
                providerWriteTailByCoordinationKey.delete(this.coordinationKey);
            }
        }
    }
}

class ALAdmissionWriteBuffer implements ALAdmissionWriteContext {
    private readonly pending = new Map<string, ALAdmissionStoredValue | undefined>();
    private readonly storage: ALAdmissionWriteContext;
    private readonly nowMs: () => number;

    constructor(storage: ALAdmissionWriteContext, nowMs: () => number) {
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

    async flush(): Promise<void> {
        for (const [key, stored] of this.pending) {
            if (stored) {
                await this.storage.set(key, stored.value, stored.expireAtTimestamp);
            }
            else {
                await this.storage.remove(key);
            }
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
