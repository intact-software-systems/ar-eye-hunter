import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from '@shared-server/runtime-state/read-batch/runtime-state-read-batch.ts';
import { selectRuntimeStateReadBatch } from '@shared-server/runtime-state/read-batch/select-runtime-state-read-batch.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';

export class SyntheticRtcRttRuntimeStateRepository implements RuntimeStateRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();

    findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        const entry = this.data.get(this.toCompositeKey(namespace, key));
        return Promise.resolve(entry === undefined ? undefined : { ...entry });
    }

    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return Promise.resolve(
            [...this.data.entries()]
                .filter(([key]) => key.startsWith(`${namespace}:`))
                .map(([, entry]) => ({ ...entry }))
                .sort((left, right) => left.key.localeCompare(right.key))
        );
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        return (await this.findAllEntries(namespace))
            .filter((entry) =>
                entry.key.startsWith(keyPrefix) &&
                (options.afterKey === undefined || entry.key > options.afterKey)
            )
            .slice(0, options.limit);
    }

    readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]> {
        const namespaces = new Set(selectors.map(({ namespace }) => namespace));
        return Promise.resolve(selectRuntimeStateReadBatch(
            [...namespaces].flatMap((namespace) =>
                [...this.data]
                    .filter(([compositeKey]) => compositeKey.startsWith(`${namespace}:`))
                    .map(([, entry]) => ({ namespace, entry }))
            ),
            selectors
        ));
    }

    upsert(namespace: string, key: string, value: string, expireAtTimestamp: number): Promise<void> {
        const compositeKey = this.toCompositeKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current === undefined ? 0 : current.revision + 1
        });
        return Promise.resolve();
    }

    deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toCompositeKey(namespace, key));
        return Promise.resolve();
    }

    deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;
        for (const [compositeKey, entry] of this.data) {
            if (compositeKey.startsWith(`${namespace}:`) && entry.expireAtTimestamp <= Date.now()) {
                this.data.delete(compositeKey);
                deleted += 1;
            }
        }
        return Promise.resolve(deleted);
    }

    private toCompositeKey(namespace: string, key: string): string {
        return `${namespace}:${key}`;
    }
}
