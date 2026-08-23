import type { PersistenceProvider, PersistenceSetItemOptions } from '@shared/persistence/PersistenceProvider.ts';
import type { JsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import { decodeJsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateRepositoryLike } from './runtime-state-repository.ts';

export interface RuntimeStateJsonPersistenceCodec<V> {
    encode(value: V): JsonWireValue;
    decode(value: JsonWireValue): V;
}

export class RuntimeStateJsonPersistenceProvider<V> implements PersistenceProvider<string, V> {
    private readonly repository: RuntimeStateRepositoryLike;
    private readonly namespace: string;
    private readonly codec: RuntimeStateJsonPersistenceCodec<V>;

    constructor(
        repository: RuntimeStateRepositoryLike,
        namespace: string,
        codec: RuntimeStateJsonPersistenceCodec<V>
    ) {
        this.repository = repository;
        this.namespace = namespace;
        this.codec = codec;
    }

    async getItem(key: string): Promise<V | undefined> {
        const entry = await this.repository.findEntry(this.namespace, key);
        if (!entry) {
            return undefined;
        }

        if (this.isExpired(entry.expireAtTimestamp)) {
            await this.repository.deleteByKey(this.namespace, key);
            return undefined;
        }

        return this.codec.decode(parseStoredValue(entry.value, this.namespace, key));
    }

    async setItem(key: string, value: V, options: PersistenceSetItemOptions): Promise<void> {
        await this.repository.upsert(
            this.namespace,
            key,
            JSON.stringify(this.codec.encode(value)),
            this.toExpireAtTimestamp(options.expireAtTimestamp)
        );
    }

    async removeItem(key: string): Promise<void> {
        await this.repository.deleteByKey(this.namespace, key);
    }

    async getAllKeys(): Promise<string[]> {
        const keys: string[] = [];

        for (const entry of await this.repository.findAllEntries(this.namespace)) {
            if (this.isExpired(entry.expireAtTimestamp)) {
                await this.repository.deleteByKey(this.namespace, entry.key);
                continue;
            }

            keys.push(entry.key);
        }

        return keys;
    }

    async deleteExpired(): Promise<number> {
        return await this.repository.deleteExpired(this.namespace);
    }

    private isExpired(expireAtTimestamp: number): boolean {
        return !Number.isFinite(expireAtTimestamp) || expireAtTimestamp <= Date.now();
    }

    private toExpireAtTimestamp(expireAtTimestamp: number): number {
        if (!Number.isFinite(expireAtTimestamp)) {
            throw new Error('expireAtTimestamp must be a finite number');
        }

        return expireAtTimestamp;
    }
}

function parseStoredValue(value: string, namespace: string, key: string): JsonWireValue {
    try {
        return decodeJsonWireValue(
            JSON.parse(value),
            `Stored runtime state ${namespace}/${key}`
        );
    }
    catch (error) {
        throw new Error(
            `Stored runtime state ${namespace}/${key} is not valid JSON`,
            { cause: error }
        );
    }
}
