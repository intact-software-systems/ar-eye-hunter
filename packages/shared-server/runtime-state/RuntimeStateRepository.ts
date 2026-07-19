export type RuntimeStateEntry = Readonly<{
    key: string;
    value: string;
    expireAtTimestamp: number;
    updatedTimestamp: string;
    revision: number;
}>;

export type RuntimeStateEntryPageOptions = Readonly<{
    afterKey?: string;
    limit: number;
}>;

export type RuntimeStateRepositoryLike = Readonly<{
    findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined>;
    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]>;
    upsert(namespace: string, key: string, value: string, expireAtTimestamp: number): Promise<void>;
    deleteByKey(namespace: string, key: string): Promise<void>;
    deleteExpired(namespace: string): Promise<number>;
}>;

export type RuntimeStateConditionalWriteResult =
    | Readonly<{ status: 'applied'; revision: number }>
    | Readonly<{ status: 'conflict' }>;

export type RuntimeStateConditionalDeleteResult =
    | Readonly<{ status: 'applied' }>
    | Readonly<{ status: 'conflict' }>;

export type RuntimeStateConditionalRepositoryLike = Readonly<{
    insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult>;
    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult>;
    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult>;
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
        findEntriesByKeys(
            namespace: string,
            keys: readonly string[],
        ): Promise<readonly RuntimeStateEntry[]>;
        lockKey(namespace: string, key: string): Promise<void>;
    }>;

export type RuntimeStateOptimisticTransactionalRepositoryLike =
    & Omit<RuntimeStateTransactionalRepositoryLike, 'begin'>
    & RuntimeStateConditionalRepositoryLike
    & Readonly<{
        begin<T>(
            fn: (
                repository: RuntimeStateOptimisticTransactionalRepositoryLike,
            ) => Promise<T>,
        ): Promise<T>;
    }>;

export type RuntimeStatePrefixPageRepositoryLike = Readonly<{
    findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntry[]>;
}>;

export function isRuntimeStateTransactionalRepositoryLike(
    repository: RuntimeStateRepositoryLike,
): repository is RuntimeStateTransactionalRepositoryLike {
    return 'begin' in repository &&
        'findEntriesByPrefix' in repository &&
        'findEntriesByKeys' in repository &&
        'lockKey' in repository;
}

export function isRuntimeStateConditionalRepositoryLike(
    repository: RuntimeStateRepositoryLike,
): repository is RuntimeStateRepositoryLike & RuntimeStateConditionalRepositoryLike {
    const candidate = repository as RuntimeStateRepositoryLike &
        Readonly<Record<string, unknown>>;
    return typeof candidate.insertIfAbsent === 'function' &&
        typeof candidate.upsertIfRevision === 'function' &&
        typeof candidate.deleteIfRevision === 'function';
}

export function isRuntimeStateOptimisticTransactionalRepositoryLike(
    repository: RuntimeStateRepositoryLike,
): repository is RuntimeStateOptimisticTransactionalRepositoryLike {
    return isRuntimeStateConditionalRepositoryLike(repository) &&
        isRuntimeStateTransactionalRepositoryLike(repository);
}

export function assertRuntimeStateExpectedRevision(
    expectedRevision: number,
): void {
    assertRuntimeStateExpectedRevisionWithinLimit(
        expectedRevision,
        Number.MAX_SAFE_INTEGER,
        'runtime state expected revision',
    );
}

export function assertRuntimeStateUpsertExpectedRevision(
    expectedRevision: number,
): void {
    assertRuntimeStateExpectedRevisionWithinLimit(
        expectedRevision,
        Number.MAX_SAFE_INTEGER - 1,
        'runtime state upsert expected revision',
    );
}

export function isRuntimeStatePrefixPageRepositoryLike(
    repository: RuntimeStateRepositoryLike,
): repository is RuntimeStateRepositoryLike & RuntimeStatePrefixPageRepositoryLike {
    return 'findEntriesByPrefixPage' in repository;
}

function assertRuntimeStateExpectedRevisionWithinLimit(
    expectedRevision: number,
    maximum: number,
    label: string,
): void {
    if (
        !Number.isSafeInteger(expectedRevision) ||
        Object.is(expectedRevision, -0) ||
        expectedRevision < 0 ||
        expectedRevision > maximum
    ) {
        throw new Error(`Invalid ${label}: ${expectedRevision}`);
    }
}
