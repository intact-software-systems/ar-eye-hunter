import type {
    PersistenceProvider,
    PersistenceSetItemOptions,
} from '@shared/persistence/PersistenceProvider.ts';
import type { RuntimeStateRepositoryLike } from '@shared-server/runtime-state/RuntimeStateRepository.ts';

export class PSqlJsonPersistenceProvider<V> implements PersistenceProvider<string, V> {
    constructor(
        private readonly repository: RuntimeStateRepositoryLike,
        private readonly namespace: string,
    ) {}

    async getItem(key: string): Promise<V | undefined> {
        const entry = await this.repository.findEntry(this.namespace, key);
        if (!entry) {
            return undefined;
        }

        if (this.isExpired(entry.expireAtTimestamp)) {
            await this.repository.deleteByKey(this.namespace, key);
            return undefined;
        }

        return JSON.parse(entry.value) as V;
    }

    async setItem(key: string, value: V, options: PersistenceSetItemOptions): Promise<void> {
        await this.repository.upsert(
            this.namespace,
            key,
            JSON.stringify(value),
            this.toExpireAtTimestamp(options.expireAtTimestamp),
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
