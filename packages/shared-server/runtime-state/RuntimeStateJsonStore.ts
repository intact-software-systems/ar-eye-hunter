import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    isRuntimeStatePrefixPageRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateEntry,
    type RuntimeStateEntryPageOptions,
    type RuntimeStateRepositoryLike,
} from './RuntimeStateRepository.ts';

type ScopedRef = Readonly<{
    applicationId: string;
    workspaceId?: string;
}>;

export type RuntimeStateEntryValue<T> = Readonly<{
    entry: RuntimeStateEntry;
    value: T;
}>;

export class RuntimeStateJsonStore {
    constructor(protected readonly repository: RuntimeStateRepositoryLike) {}

    protected async putValue(
        namespace: string,
        key: string,
        value: unknown,
        expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP,
    ): Promise<void> {
        await this.repository.upsert(namespace, key, JSON.stringify(value), expireAtTimestamp);
    }

    protected async getValue<T>(namespace: string, key: string): Promise<T | undefined> {
        return (await this.getEntryValue<T>(namespace, key))?.value;
    }

    protected async listValues<T>(namespace: string, keyPrefix?: string): Promise<readonly T[]> {
        return (await this.listEntryValues<T>(namespace, keyPrefix))
            .map(({ value }) => value);
    }

    protected async getEntryValue<T>(
        namespace: string,
        key: string,
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        const entry = await this.repository.findEntry(namespace, key);
        if (!entry) {
            return undefined;
        }

        const value = await this.toLiveValue<T>(namespace, entry);
        return value === undefined ? undefined : { entry, value };
    }

    protected async listEntryValues<T>(
        namespace: string,
        keyPrefix?: string,
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        const entries = await this.listEntries(namespace, keyPrefix);
        const values: RuntimeStateEntryValue<T>[] = [];
        for (const entry of entries) {
            const value = await this.toLiveValue<T>(namespace, entry);
            if (value !== undefined) {
                values.push({ entry, value });
            }
        }
        return values;
    }

    protected async listEntryValuesByKeys<T>(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        if (keys.length === 0) {
            return [];
        }

        const entries = isRuntimeStateTransactionalRepositoryLike(this.repository)
            ? await this.repository.findEntriesByKeys(namespace, keys)
            : (await Promise.all(
                keys.map((key) => this.repository.findEntry(namespace, key)),
            )).filter((entry): entry is RuntimeStateEntry => entry !== undefined);
        const values: RuntimeStateEntryValue<T>[] = [];
        for (const entry of entries) {
            const value = await this.toLiveValue<T>(namespace, entry);
            if (value !== undefined) {
                values.push({ entry, value });
            }
        }
        return values;
    }

    protected async listEntriesPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntry[]> {
        const limit = Math.max(1, Math.floor(options.limit));

        if (isRuntimeStatePrefixPageRepositoryLike(this.repository)) {
            return await this.repository.findEntriesByPrefixPage(
                namespace,
                keyPrefix,
                {
                    afterKey: options.afterKey,
                    limit,
                },
            );
        }

        return (await this.listEntries(namespace, keyPrefix))
            .filter((entry) =>
                options.afterKey === undefined ||
                entry.key.localeCompare(options.afterKey) > 0
            )
            .slice(0, limit);
    }

    protected async toLiveValues<T>(
        namespace: string,
        entries: readonly RuntimeStateEntry[],
    ): Promise<readonly T[]> {
        const values: T[] = [];

        for (const entry of entries) {
            const value = await this.toLiveValue<T>(namespace, entry);
            if (value !== undefined) {
                values.push(value);
            }
        }

        return values;
    }

    protected async deleteValue(namespace: string, key: string): Promise<void> {
        await this.repository.deleteByKey(namespace, key);
    }

    protected scopeKey(scope: ScopedRef): string {
        return [
            this.toKeyPart('app', scope.applicationId),
            this.toKeyPart('ws', scope.workspaceId),
        ].join(':');
    }

    protected scopeChildPrefix(scope: ScopedRef): string {
        return this.childKeyPrefix(this.scopeKey(scope));
    }

    protected childKeyPrefix(parentKey: string): string {
        return `${parentKey}:`;
    }

    protected idKey(name: string, value: string): string {
        return this.toKeyPart(name, value);
    }

    protected timeKey(timestamp: number): string {
        return String(timestamp).padStart(13, '0');
    }

    protected neverExpireAtTimestamp(): number {
        return NEVER_EXPIRE_AT_TIMESTAMP;
    }

    private async listEntries(
        namespace: string,
        keyPrefix?: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keyPrefix !== undefined && isRuntimeStateTransactionalRepositoryLike(this.repository)) {
            return await this.repository.findEntriesByPrefix(namespace, keyPrefix);
        }

        const entries = await this.repository.findAllEntries(namespace);
        if (keyPrefix === undefined) {
            return entries;
        }

        return entries.filter((entry) => entry.key.startsWith(keyPrefix));
    }

    protected async toLiveValue<T>(
        namespace: string,
        entry: RuntimeStateEntry,
    ): Promise<T | undefined> {
        if (entry.expireAtTimestamp <= Date.now()) {
            await this.repository.deleteByKey(namespace, entry.key);
            return undefined;
        }

        return JSON.parse(entry.value) as T;
    }

    private toKeyPart(name: string, value?: string): string {
        return `${name}=${encodeURIComponent(value ?? '_')}`;
    }
}
