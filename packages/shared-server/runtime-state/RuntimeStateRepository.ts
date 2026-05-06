export type RuntimeStateEntry = Readonly<{
    key: string;
    value: string;
    expireAtTimestamp: number;
    updatedTimestamp: string;
    revision: number;
}>;

export type RuntimeStateRepositoryLike = Readonly<{
    findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined>;
    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]>;
    upsert(namespace: string, key: string, value: string, expireAtTimestamp: number): Promise<void>;
    deleteByKey(namespace: string, key: string): Promise<void>;
    deleteExpired(namespace: string): Promise<number>;
}>;

export type RuntimeStateTransactionalRepositoryLike = RuntimeStateRepositoryLike &
    Readonly<{
        begin<T>(
            fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
        ): Promise<T>;
        findEntriesByPrefix(
            namespace: string,
            keyPrefix: string,
        ): Promise<readonly RuntimeStateEntry[]>;
        lockKey(namespace: string, key: string): Promise<void>;
    }>;

export function isRuntimeStateTransactionalRepositoryLike(
    repository: RuntimeStateRepositoryLike,
): repository is RuntimeStateTransactionalRepositoryLike {
    return 'begin' in repository && 'findEntriesByPrefix' in repository && 'lockKey' in repository;
}
