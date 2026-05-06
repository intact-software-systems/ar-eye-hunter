import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import {
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateEntry,
    type RuntimeStateRepositoryLike,
} from './RuntimeStateRepository.ts';

type ScopedRef = Readonly<{
    applicationId: string;
    workspaceId?: string;
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
        const entry = await this.repository.findEntry(namespace, key);
        if (!entry) {
            return undefined;
        }

        return await this.toLiveValue<T>(namespace, entry);
    }

    protected async listValues<T>(namespace: string, keyPrefix?: string): Promise<readonly T[]> {
        const entries = await this.listEntries(namespace, keyPrefix);
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

    private async toLiveValue<T>(
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
