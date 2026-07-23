// deno-lint-ignore-file require-await
import type {
    RuntimeStateConditionalDeleteResult,
    RuntimeStateConditionalWriteResult,
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

export class FakeRuntimeStateRepository implements RuntimeStateOptimisticTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    readonly lockedKeys: Array<Readonly<{ namespace: string; key: string }>> = [];
    readonly conditionalWrites: Array<Readonly<{
        operation: 'insert' | 'replace' | 'delete';
        namespace: string;
        key: string;
        expectedRevision: number | null;
    }>> = [];
    readonly findEntriesByPrefixCalls: Array<
        Readonly<{ namespace: string; keyPrefix: string }>
    > = [];
    readonly findEntriesByPrefixPageCalls: Array<
        Readonly<{
            namespace: string;
            keyPrefix: string;
            afterKey?: string;
            limit: number;
        }>
    > = [];
    conflictNextConditionalWrite = false;
    errorNextConditionalWrite: Error | undefined;
    conflictCount = 0;

    async begin<T>(
        fn: (repository: RuntimeStateOptimisticTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toKey(namespace, key));
        return entry ? { ...entry } : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
            .map(([, entry]) => ({ ...entry }));
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls.push({ namespace, keyPrefix });
        return this.findPrefixEntries(namespace, keyPrefix);
    }

    async findEntriesByKeys(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntry[]> {
        const keySet = new Set(keys);
        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    keySet.has(this.toStoreKey(compositeKey)),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixPageCalls.push({
            namespace,
            keyPrefix,
            afterKey: options.afterKey,
            limit: options.limit,
        });

        return this.findPrefixEntries(namespace, keyPrefix)
            .filter((entry) =>
                options.afterKey === undefined ||
                entry.key.localeCompare(options.afterKey) > 0
            )
            .slice(0, options.limit);
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
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

    async deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
    }

    async deleteExpired(namespace: string): Promise<number> {
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

        return deleted;
    }

    async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult> {
        this.conditionalWrites.push({
            operation: 'insert',
            namespace,
            key,
            expectedRevision: null,
        });
        if (this.errorNextConditionalWrite) {
            const error = this.errorNextConditionalWrite;
            this.errorNextConditionalWrite = undefined;
            throw error;
        }
        if (this.conflictNextConditionalWrite) {
            this.conflictNextConditionalWrite = false;
            this.conflictCount += 1;
            return { status: 'conflict' };
        }
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) return { status: 'conflict' };
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
        this.conditionalWrites.push({
            operation: 'replace',
            namespace,
            key,
            expectedRevision,
        });
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) return { status: 'conflict' };
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
        this.conditionalWrites.push({
            operation: 'delete',
            namespace,
            key,
            expectedRevision,
        });
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        if (!current || current.revision !== expectedRevision) return { status: 'conflict' };
        this.data.delete(compositeKey);
        return { status: 'applied' };
    }

    async lockKey(namespace: string, key: string): Promise<void> {
        this.lockedKeys.push({ namespace, key });
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private findPrefixEntries(
        namespace: string,
        keyPrefix: string,
    ): RuntimeStateEntry[] {
        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
