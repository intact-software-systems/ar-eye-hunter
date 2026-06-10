export type AppDataEntry<V = unknown> = Readonly<{
    namespace: string;
    storeName: string;
    key: string;
    value: V;
    schemaVersion: number;
    expireAtTimestamp: number;
    updatedTimestamp: string;
    revision: number;
}>;

export type AppDataUpsertInput<V = unknown> = Readonly<{
    namespace: string;
    storeName: string;
    key: string;
    value: V;
    schemaVersion: number;
    expireAtTimestamp: number;
}>;

export type AppDataUpsertIfRevisionInput<V = unknown> = AppDataUpsertInput<V> &
    Readonly<{
        expectedRevision: number;
    }>;

export type AppDataConditionalWriteResult<V = unknown> =
    | Readonly<{
        status: 'written';
        entry: AppDataEntry<V>;
    }>
    | Readonly<{
        status: 'conflict';
        current?: AppDataEntry<V>;
    }>;

export type AppDataConditionalInsertResult<V = unknown> =
    | Readonly<{
        status: 'inserted';
        entry: AppDataEntry<V>;
    }>
    | Readonly<{
        status: 'exists';
        current?: AppDataEntry<V>;
    }>;

export type AppDataConditionalDeleteResult<V = unknown> =
    | Readonly<{
        status: 'deleted';
        entry: AppDataEntry<V>;
    }>
    | Readonly<{
        status: 'conflict';
        current?: AppDataEntry<V>;
    }>;

export type AppDataRepositoryLike = Readonly<{
    findEntry(
        namespace: string,
        storeName: string,
        key: string,
    ): Promise<AppDataEntry | undefined>;
    findEntries(
        namespace: string,
        storeName: string,
        keyPrefix?: string,
    ): Promise<readonly AppDataEntry[]>;
    upsert(input: AppDataUpsertInput): Promise<void>;
    deleteByKey(namespace: string, storeName: string, key: string): Promise<boolean>;
    deleteExpired(namespace: string, storeName?: string): Promise<number>;
}>;

export type AppDataConditionalRepositoryLike = AppDataRepositoryLike &
    Readonly<{
        insertIfAbsent<V = unknown>(
            input: AppDataUpsertInput<V>,
        ): Promise<AppDataConditionalInsertResult<V>>;
        upsertIfRevision<V = unknown>(
            input: AppDataUpsertIfRevisionInput<V>,
        ): Promise<AppDataConditionalWriteResult<V>>;
        deleteIfRevision(
            namespace: string,
            storeName: string,
            key: string,
            expectedRevision: number,
        ): Promise<AppDataConditionalDeleteResult>;
    }>;

export function isAppDataConditionalRepository(
    repository: AppDataRepositoryLike,
): repository is AppDataConditionalRepositoryLike {
    const candidate = repository as Partial<AppDataConditionalRepositoryLike>;
    return typeof candidate.insertIfAbsent === 'function' &&
        typeof candidate.upsertIfRevision === 'function' &&
        typeof candidate.deleteIfRevision === 'function';
}
