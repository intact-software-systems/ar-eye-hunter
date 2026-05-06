import type {
    ALInboundAdmissionBackend,
    ALInboundAdmissionWriteContext,
} from '@shared/alm/ALInboundAdmissionStore.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

export class PSqlInboundAdmissionBackend implements ALInboundAdmissionBackend {
    constructor(
        private readonly repository: RuntimeStateTransactionalRepositoryLike,
        private readonly namespace: string,
    ) {
    }

    async ready(): Promise<void> {
    }

    async get<V>(key: string): Promise<V | undefined> {
        return await this.readValue<V>(this.repository, key);
    }

    async list<V>(prefix: string): Promise<readonly Readonly<{ key: string; value: V }>[]> {
        return await this.readPrefix<V>(this.repository, prefix);
    }

    async write<T>(fn: (tx: ALInboundAdmissionWriteContext) => Promise<T>): Promise<T> {
        return await this.repository.begin(
            async (txRepository) =>
                await fn({
                    get: async (key) => await this.readValue(txRepository, key),
                    list: async (prefix) => await this.readPrefix(txRepository, prefix),
                    lock: async (key) => {
                        await txRepository.lockKey(this.namespace, key);
                    },
                    set: async (key, value, expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP) => {
                        await txRepository.upsert(
                            this.namespace,
                            key,
                            JSON.stringify(value),
                            expireAtTimestamp,
                        );
                    },
                    remove: async (key) => {
                        await txRepository.deleteByKey(this.namespace, key);
                    },
                }),
        );
    }

    private async readValue<V>(
        repository: RuntimeStateTransactionalRepositoryLike,
        key: string,
    ): Promise<V | undefined> {
        const entry = await repository.findEntry(this.namespace, key);
        if (!entry) {
            return undefined;
        }

        if (isExpired(entry)) {
            await repository.deleteByKey(this.namespace, key);
            return undefined;
        }

        return JSON.parse(entry.value) as V;
    }

    private async readPrefix<V>(
        repository: RuntimeStateTransactionalRepositoryLike,
        prefix: string,
    ): Promise<readonly Readonly<{ key: string; value: V }>[]> {
        const values: Array<Readonly<{ key: string; value: V }>> = [];

        for (const entry of await repository.findEntriesByPrefix(this.namespace, prefix)) {
            if (isExpired(entry)) {
                await repository.deleteByKey(this.namespace, entry.key);
                continue;
            }

            values.push({
                key: entry.key,
                value: JSON.parse(entry.value) as V,
            });
        }

        return values;
    }
}

function isExpired(entry: RuntimeStateEntry): boolean {
    return !Number.isFinite(entry.expireAtTimestamp) || entry.expireAtTimestamp <= Date.now();
}
