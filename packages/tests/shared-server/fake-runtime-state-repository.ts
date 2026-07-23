import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

export class FakeRuntimeStateRepository
    implements RuntimeStateOptimisticTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    readonly locks: Array<Readonly<{ namespace: string; key: string }>> = [];
    beforeUpsert?: (namespace: string, key: string) => void | Promise<void>;
    beforeConditionalWrite?: (
        operation: 'insertIfAbsent' | 'upsertIfRevision' | 'deleteIfRevision',
        namespace: string,
        key: string,
    ) => void | Promise<void>;
    serializeTransactions = false;
    private transactionTail: Promise<void> = Promise.resolve();

    async begin<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        ) => Promise<T>,
    ): Promise<T> {
        if (this.serializeTransactions) {
            const previous = this.transactionTail;
            let release!: () => void;
            this.transactionTail = new Promise<void>((resolve) => {
                release = resolve;
            });
            await previous;
            try {
                return await this.beginUnserialized(fn);
            } finally {
                release();
            }
        }
        return await this.beginUnserialized(fn);
    }

    private async beginUnserialized<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionalRepositoryLike,
        ) => Promise<T>,
    ): Promise<T> {
        const before = new Map(this.data);
        try {
            return await fn(this);
        } catch (error) {
            this.data.clear();
            for (const [key, entry] of before) {
                this.data.set(key, entry);
            }
            throw error;
        }
    }

    findEntry(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        this.toStoreKey(compositeKey).startsWith(keyPrefix),
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntry[]> {
        return (await this.findEntriesByPrefix(namespace, keyPrefix))
            .filter((entry) =>
                options.afterKey === undefined || entry.key > options.afterKey
            )
            .slice(0, options.limit);
    }

    findEntriesByKeys(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        keySet.has(this.toStoreKey(compositeKey)),
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key)),
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        return this.upsertAfterHook(namespace, key, value, expireAtTimestamp);
    }

    private async upsertAfterHook(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        await this.beforeUpsert?.(namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        await this.beforeConditionalWrite?.('insertIfAbsent', namespace, key);
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) {
            return { status: 'conflict' };
        }

        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: 0,
        });
        return { status: 'applied', revision: 0 };
    }

    async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        await this.beforeConditionalWrite?.('upsertIfRevision', namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return { status: 'conflict' };
        }

        const revision = current.revision + 1;
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision,
        });
        return { status: 'applied', revision };
    }

    async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult> {
        assertRuntimeStateExpectedRevision(expectedRevision);
        await this.beforeConditionalWrite?.('deleteIfRevision', namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return { status: 'conflict' };
        }

        this.data.delete(compositeKey);
        return { status: 'applied' };
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;

        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return Promise.resolve(deleted);
    }

    lockKey(namespace: string, key: string): Promise<void> {
        this.locks.push({ namespace, key });
        return Promise.resolve();
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
