import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { decodeJsonWireValue } from '../rallar-system/protocol/json-wire-identity.ts';
import type { RuntimeStateReadBatchSelector } from './read-batch/runtime-state-read-batch.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStatePrefixPageRepositoryLike,
    type RuntimeStateConditionalDeleteResult,
    type RuntimeStateConditionalRepositoryLike,
    type RuntimeStateConditionalWriteResult,
    type RuntimeStateEntry,
    type RuntimeStateEntryPageOptions,
    type RuntimeStateRepositoryLike
} from './runtime-state-repository.ts';

interface ScopedRef {
    readonly applicationId: string;
    readonly workspaceId?: string;
}

export interface RuntimeStateEntryValue<T> {
    readonly entry: RuntimeStateEntry;
    readonly value: T;
}

export interface RuntimeStateEntryRead<T> {
    readonly value: RuntimeStateEntryValue<T> | undefined;
    readonly expiredEntry: RuntimeStateEntry | undefined;
}

export class RuntimeStateJsonStore {
    protected readonly repository: RuntimeStateRepositoryLike;

    constructor(repository: RuntimeStateRepositoryLike) {
        this.repository = repository;
    }

    protected async putValue(
        namespace: string,
        key: string,
        value: object,
        expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP
    ): Promise<void> {
        await this.repository.upsert(
            namespace,
            key,
            serializeRuntimeStateJsonValue(value),
            expireAtTimestamp
        );
    }

    protected async putValueIfAbsent(
        namespace: string,
        key: string,
        value: object,
        expireAtTimestamp = NEVER_EXPIRE_AT_TIMESTAMP
    ): Promise<RuntimeStateConditionalWriteResult> {
        const repository = this.conditionalRepository();
        const serializedValue = serializeRuntimeStateJsonValue(value);
        return await repository.insertIfAbsent(
            namespace,
            key,
            serializedValue,
            expireAtTimestamp
        );
    }

    protected async putValueIfRevision(
        namespace: string,
        key: string,
        value: object,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult> {
        const repository = this.conditionalRepository();
        const serializedValue = serializeRuntimeStateJsonValue(value);
        return await repository.upsertIfRevision(
            namespace,
            key,
            serializedValue,
            expireAtTimestamp,
            expectedRevision
        );
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
        key: string
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        const entry = await this.repository.findEntry(namespace, key);
        if (!entry) {
            return undefined;
        }

        return await this.toLiveEntryValue<T>(namespace, entry);
    }

    protected async getEntryRead<T>(
        namespace: string,
        key: string
    ): Promise<RuntimeStateEntryRead<T>> {
        const entry = await this.repository.findEntry(namespace, key);
        if (!entry) {
            return { value: undefined, expiredEntry: undefined };
        }
        const value = await this.toLiveEntryValue<T>(namespace, entry);
        return value
            ? { value, expiredEntry: undefined }
            : { value: undefined, expiredEntry: entry };
    }

    protected async listEntryValues<T>(
        namespace: string,
        keyPrefix?: string
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        const entries = await this.listEntries(namespace, keyPrefix);
        const values: RuntimeStateEntryValue<T>[] = [];
        for (const entry of entries) {
            const value = await this.toLiveEntryValue<T>(namespace, entry);
            if (value !== undefined) {
                values.push(value);
            }
        }
        return values;
    }

    protected async listEntryValuesByKeys<T>(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntryValue<T>[]> {
        if (keys.length === 0) {
            return [];
        }

        const selectors: readonly RuntimeStateReadBatchSelector[] = [...new Set(keys)]
            .sort(compareUtf8)
            .map((key, index) => ({
                selectorId: `key:${index}`,
                kind: 'key',
                namespace,
                key
            }));
        const entries = (await this.repository.readRuntimeStateBatch(selectors))
            .flatMap((selection) => selection.entries);
        const values: RuntimeStateEntryValue<T>[] = [];
        for (const entry of entries) {
            const value = await this.toLiveEntryValue<T>(namespace, entry);
            if (value !== undefined) {
                values.push(value);
            }
        }
        return values;
    }

    protected async listEntriesPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]> {
        const limit = Math.max(1, Math.floor(options.limit));

        if (isRuntimeStatePrefixPageRepositoryLike(this.repository)) {
            return await this.repository.findEntriesByPrefixPage(
                namespace,
                keyPrefix,
                {
                    afterKey: options.afterKey,
                    limit
                }
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
        entries: readonly RuntimeStateEntry[]
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

    protected async deleteValueIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult> {
        return await this.conditionalRepository().deleteIfRevision(
            namespace,
            key,
            expectedRevision
        );
    }

    protected scopeKey(scope: ScopedRef): string {
        return [
            this.toKeyPart('app', scope.applicationId),
            this.toKeyPart('ws', scope.workspaceId)
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
        keyPrefix?: string
    ): Promise<readonly RuntimeStateEntry[]> {
        if (keyPrefix === undefined) {
            return await this.repository.findAllEntries(namespace);
        }
        const [selection] = await this.repository.readRuntimeStateBatch([{
            selectorId: 'prefix',
            kind: 'prefix',
            namespace,
            keyPrefix
        }]);
        return selection.entries;
    }

    protected async toLiveValue<T>(
        namespace: string,
        entry: RuntimeStateEntry
    ): Promise<T | undefined> {
        return (await this.toLiveEntryValue<T>(namespace, entry))?.value;
    }

    protected async toLiveEntryValue<T>(
        _namespace: string,
        entry: RuntimeStateEntry
    ): Promise<RuntimeStateEntryValue<T> | undefined> {
        return entry.expireAtTimestamp > Date.now()
            ? { entry, value: decodeRuntimeStateJsonValue<T>(entry.value) }
            : undefined;
    }

    private conditionalRepository():
        & RuntimeStateRepositoryLike
        & RuntimeStateConditionalRepositoryLike {
        if (!isRuntimeStateConditionalRepositoryLike(this.repository)) {
            throw new Error('A conditional runtime state repository is required');
        }
        return this.repository;
    }

    private toKeyPart(name: string, value?: string): string {
        return `${name}=${encodeURIComponent(value ?? '_')}`;
    }
}

function serializeRuntimeStateJsonValue(value: object): string {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
        throw new TypeError('Runtime state value cannot be represented as JSON');
    }
    decodeJsonWireValue(JSON.parse(serialized), 'Runtime state value');
    return serialized;
}

function decodeRuntimeStateJsonValue<T>(serialized: string): T {
    return decodeJsonWireValue(
        JSON.parse(serialized),
        'Stored runtime state value'
    ) as T;
}

function compareUtf8(left: string, right: string): number {
    const encoder = new TextEncoder();
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
        const difference = leftBytes[index] - rightBytes[index];
        if (difference !== 0) {
            return difference;
        }
    }
    return leftBytes.length - rightBytes.length;
}
