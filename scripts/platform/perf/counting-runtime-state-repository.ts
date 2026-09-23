import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateOptimisticTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';
import {
    assertRuntimeStateExpectedRevision,
    assertRuntimeStateUpsertExpectedRevision
} from '@shared-server/runtime-state/runtime-state-repository.ts';

export class CountingRuntimeStateRepository implements RuntimeStateOptimisticTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findAllEntriesCalls = 0;
    findEntriesByPrefixCalls = 0;
    readRuntimeStateBatchCalls = 0;
    readonly readRuntimeStateBatchCallsByNamespace = new Map<string, number>();
    maxRowsReturnedPerReadBatchSelector = 0;

    async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>
    ): Promise<T> {
        return await fn(this);
    }

    findEntry(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntry | undefined> {
        this.findEntryCalls += 1;
        const entry = this.data.get(this.toKey(namespace, key));
        return Promise.resolve(entry ? { ...entry } : undefined);
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        this.findAllEntriesCalls += 1;
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        this.readRuntimeStateBatchCalls += 1;
        for (const { namespace } of selectors) {
            this.readRuntimeStateBatchCallsByNamespace.set(
                namespace,
                (this.readRuntimeStateBatchCallsByNamespace.get(namespace) ?? 0) + 1
            );
        }
        const selections = selectRuntimeStateReadBatch(
            [...this.data].map(([compositeKey, entry]) => ({
                namespace: this.toNamespace(compositeKey),
                entry
            })),
            selectors
        );
        this.maxRowsReturnedPerReadBatchSelector = Math.max(
            this.maxRowsReturnedPerReadBatchSelector,
            ...selections.map(({ entries }) => entries.length)
        );
        return Promise.resolve(selections);
    }

    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls += 1;
        const rows = [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix)
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
        return Promise.resolve(rows);
    }

    findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        const rows = [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix) &&
                    (options.afterKey === undefined ||
                        this.toStoreKey(compositeKey) > options.afterKey)
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key))
            .slice(0, options.limit);
        return Promise.resolve(rows);
    }

    findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    keySet.has(this.toStoreKey(compositeKey))
                )
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0
        });
        return Promise.resolve();
    }

    insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<{ status: 'applied'; revision: number; } | { status: 'conflict'; }> {
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) {
            return Promise.resolve({ status: 'conflict' });
        }
        this.data.set(compositeKey, this.entry(key, value, expireAtTimestamp, 0));
        return Promise.resolve({ status: 'applied', revision: 0 });
    }

    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<{ status: 'applied'; revision: number; } | { status: 'conflict'; }> {
        assertRuntimeStateUpsertExpectedRevision(expectedRevision);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return Promise.resolve({ status: 'conflict' });
        }
        const revision = expectedRevision + 1;
        this.data.set(compositeKey, this.entry(key, value, expireAtTimestamp, revision));
        return Promise.resolve({ status: 'applied', revision });
    }

    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<{ status: 'applied'; } | { status: 'conflict'; }> {
        assertRuntimeStateExpectedRevision(expectedRevision);
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) {
            return Promise.resolve({ status: 'conflict' });
        }
        this.data.delete(compositeKey);
        return Promise.resolve({ status: 'applied' });
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;
        for (const [compositeKey, entry] of this.data.entries()) {
            if (
                this.toNamespace(compositeKey) === namespace &&
                entry.expireAtTimestamp <= Date.now()
            ) {
                this.data.delete(compositeKey);
                deleted += 1;
            }
        }
        return Promise.resolve(deleted);
    }

    resetCounters(): void {
        this.findEntryCalls = 0;
        this.findAllEntriesCalls = 0;
        this.findEntriesByPrefixCalls = 0;
        this.readRuntimeStateBatchCalls = 0;
        this.readRuntimeStateBatchCallsByNamespace.clear();
        this.maxRowsReturnedPerReadBatchSelector = 0;
    }

    batchReadCounts(): Readonly<Record<string, number>> {
        return Object.fromEntries(
            [...this.readRuntimeStateBatchCallsByNamespace.entries()].sort(([left], [right]) =>
                left.localeCompare(right)
            )
        );
    }

    private entry(
        key: string,
        value: string,
        expireAtTimestamp: number,
        revision: number
    ): RuntimeStateEntry {
        return {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision
        };
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
