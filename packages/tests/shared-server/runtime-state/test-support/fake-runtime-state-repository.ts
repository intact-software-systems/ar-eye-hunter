import type {
    RuntimeStateGuardedBatchExactUpdate,
    RuntimeStateGuardedBatchResult,
    RuntimeStateGuardedBatchWrite
} from '@shared-server/runtime-state/guarded-batch/runtime-state-guarded-batch.ts';
import type { RuntimeStateReadBatchSelection, RuntimeStateReadBatchSelector } from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateGuardedBatchTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionRepositoryLike,
    RuntimeStateRevisionWriteInput,
    RuntimeStateWriteInput
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import { assertRuntimeStateExpectedRevision, assertRuntimeStateUpsertExpectedRevision } from '@shared-server/runtime-state/runtime-state-repository.ts';
import type { TestClientStateEventStoreOwner, TestGroupStateEventStoreOwner } from '@shared-test/shared-server/create-test-state-repositories.ts';
import { TestClientStateEventStore } from '@shared-test/shared-server/test-client-state-event-store.ts';
import { TestGroupStateEventStore } from '@shared-test/shared-server/test-group-state-event-store.ts';
import { applyFakeRuntimeStateGuardedBatch } from './apply-fake-runtime-state-guarded-batch.ts';

export class FakeRuntimeStateRepository
    implements RuntimeStateGuardedBatchTransactionalRepositoryLike, TestClientStateEventStoreOwner, TestGroupStateEventStoreOwner {
    readonly data = new Map<string, RuntimeStateEntry>();
    readonly clientStateEventStore = new TestClientStateEventStore();
    readonly groupStateEventStore = new TestGroupStateEventStore();
    beforeUpsert?: (namespace: string, key: string) => void | Promise<void>;
    beforeConditionalWrite?: (
        operation: 'insertIfAbsent' | 'upsertIfRevision' | 'deleteIfRevision',
        namespace: string,
        key: string
    ) => void | Promise<void>;
    serializeTransactions = false;
    /** The clock that decides whether a stored row has expired, as the database clock does for Postgres. */
    nowEpochMs: () => number = Date.now;
    private activeTransactionCount = 0;
    private transactionTail: Promise<void> = Promise.resolve();

    async begin<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionRepositoryLike
        ) => Promise<T>
    ): Promise<T> {
        if (this.serializeTransactions) {
            const previous = this.transactionTail;
            const next = createDeferred();
            this.transactionTail = next.promise;
            await previous;
            try {
                return await this.beginUnserialized(fn);
            }
            finally {
                next.resolve();
            }
        }
        return await this.beginUnserialized(fn);
    }

    private async beginUnserialized<T>(
        fn: (
            repository: RuntimeStateOptimisticTransactionRepositoryLike
        ) => Promise<T>
    ): Promise<T> {
        const before = new Map(this.data);
        try {
            this.activeTransactionCount += 1;
            try {
                return await fn(this);
            }
            finally {
                this.activeTransactionCount -= 1;
            }
        }
        catch (error) {
            this.data.clear();
            for (const [key, entry] of before) {
                this.data.set(key, entry);
            }
            throw error;
        }
    }

    findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    async readRuntimeStateBatch(
        input: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        return selectRuntimeStateReadBatch(
            [...this.data].map(([compositeKey, entry]) => ({
                namespace: this.toNamespace(compositeKey),
                entry: { ...entry }
            })),
            input
        );
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        this.toStoreKey(compositeKey).startsWith(keyPrefix)
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        return (await this.findEntriesByPrefix(namespace, keyPrefix))
            .filter((entry) => options.afterKey === undefined || entry.key > options.afterKey)
            .slice(0, options.limit);
    }

    findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return Promise.resolve(
            [...this.data.entries()]
                .filter(
                    ([compositeKey]) =>
                        this.toNamespace(compositeKey) === namespace &&
                        keySet.has(this.toStoreKey(compositeKey))
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    async upsert(
        { namespace, key, value, expireAtTimestamp }: RuntimeStateWriteInput
    ): Promise<void> {
        await this.beforeUpsert?.(namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0
        });
    }

    async insertIfAbsent(
        { namespace, key, value, expireAtTimestamp }: RuntimeStateWriteInput
    ): Promise<RuntimeStateConditionalWriteResult> {
        await this.beforeConditionalWrite?.('insertIfAbsent', namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (current !== undefined && current.expireAtTimestamp > this.nowEpochMs()) {
            return { status: 'conflict' };
        }
        const revision = current === undefined ? 0 : current.revision + 1;
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision
        });
        return { status: 'applied', revision };
    }

    async upsertIfRevision(input: RuntimeStateRevisionWriteInput): Promise<RuntimeStateConditionalWriteResult> {
        return await this.applyRevisionUpdate(input);
    }

    async upsertIfExactPredecessor(input: RuntimeStateGuardedBatchExactUpdate): Promise<RuntimeStateConditionalWriteResult> {
        return await this.applyRevisionUpdate(input);
    }

    private async applyRevisionUpdate(
        input: RuntimeStateRevisionWriteInput | RuntimeStateGuardedBatchExactUpdate
    ): Promise<RuntimeStateConditionalWriteResult> {
        const { namespace, key, value, expireAtTimestamp, expectedRevision } = input;
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        await this.beforeConditionalWrite?.('upsertIfRevision', namespace, key);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision || ('expectedValue' in input && current.value !== input.expectedValue)) {
            return { status: 'conflict' };
        }

        const revision = current.revision + 1;
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision
        });
        return { status: 'applied', revision };
    }

    async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
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

    async writeGuardedBatch(
        input: RuntimeStateGuardedBatchWrite
    ): Promise<RuntimeStateGuardedBatchResult> {
        if (this.activeTransactionCount === 0) {
            throw new Error('Guarded runtime state batch requires an active transaction');
        }
        return await applyFakeRuntimeStateGuardedBatch(this, input);
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

            if (entry.expireAtTimestamp > this.nowEpochMs()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return Promise.resolve(deleted);
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

interface Deferred {
    readonly promise: Promise<void>;
    resolve(): void;
}

function createDeferred(): Deferred {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve() {
            if (resolvePromise === undefined) {
                throw new Error('Deferred transaction release is unavailable');
            }
            resolvePromise();
        }
    };
}
