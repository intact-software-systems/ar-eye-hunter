import type {
    RuntimeStateReadBatchSelection,
    RuntimeStateReadBatchSelector
} from './read-batch/runtime-state-read-batch.ts';

export interface RuntimeStateEntry {
    readonly key: string;
    readonly value: string;
    readonly expireAtTimestamp: number;
    readonly updatedTimestamp: string;
    readonly revision: number;
}

export interface RuntimeStateEntryPageOptions {
    readonly afterKey?: string;
    readonly limit: number;
}

export interface RuntimeStateRepositoryLike {
    findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined>;
    findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]>;
    readRuntimeStateBatch(
        selectors: readonly RuntimeStateReadBatchSelector[]
    ): Promise<readonly RuntimeStateReadBatchSelection[]>;
    upsert(namespace: string, key: string, value: string, expireAtTimestamp: number): Promise<void>;
    deleteByKey(namespace: string, key: string): Promise<void>;
    deleteExpired(namespace: string): Promise<number>;
}

export type RuntimeStateConditionalWriteResult =
    | Readonly<{ status: 'applied'; revision: number; }>
    | Readonly<{ status: 'conflict'; }>;

export type RuntimeStateConditionalDeleteResult =
    | Readonly<{ status: 'applied'; }>
    | Readonly<{ status: 'conflict'; }>;

export interface RuntimeStateConditionalRepositoryLike {
    insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number
    ): Promise<RuntimeStateConditionalWriteResult>;
    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalWriteResult>;
    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number
    ): Promise<RuntimeStateConditionalDeleteResult>;
}

export interface RuntimeStateTransactionalRepositoryLike extends RuntimeStateRepositoryLike {
    begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>
    ): Promise<T>;
    findEntriesByPrefix(
        namespace: string,
        keyPrefix: string
    ): Promise<readonly RuntimeStateEntry[]>;
    findEntriesByKeys(
        namespace: string,
        keys: readonly string[]
    ): Promise<readonly RuntimeStateEntry[]>;
}

export type RuntimeStateOptimisticTransactionalRepositoryLike =
    & Omit<RuntimeStateTransactionalRepositoryLike, 'begin'>
    & RuntimeStateConditionalRepositoryLike
    & Readonly<{
        begin<T>(
            fn: (
                repository: RuntimeStateOptimisticTransactionalRepositoryLike
            ) => Promise<T>
        ): Promise<T>;
    }>;

export interface RuntimeStatePrefixPageRepositoryLike {
    findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntry[]>;
}

export function isRuntimeStateTransactionalRepositoryLike(
    repository: RuntimeStateRepositoryLike
): repository is RuntimeStateTransactionalRepositoryLike {
    return 'begin' in repository &&
        'findEntriesByPrefix' in repository &&
        'findEntriesByKeys' in repository;
}

export function isRuntimeStateConditionalRepositoryLike(
    repository: RuntimeStateRepositoryLike
): repository is RuntimeStateRepositoryLike & RuntimeStateConditionalRepositoryLike {
    return 'insertIfAbsent' in repository &&
        typeof repository.insertIfAbsent === 'function' &&
        'upsertIfRevision' in repository &&
        typeof repository.upsertIfRevision === 'function' &&
        'deleteIfRevision' in repository &&
        typeof repository.deleteIfRevision === 'function';
}

export function isRuntimeStateOptimisticTransactionalRepositoryLike(
    repository: RuntimeStateRepositoryLike
): repository is RuntimeStateOptimisticTransactionalRepositoryLike {
    return isRuntimeStateConditionalRepositoryLike(repository) &&
        isRuntimeStateTransactionalRepositoryLike(repository);
}

export function assertRuntimeStateExpectedRevision(
    expectedRevision: number
): void {
    assertRuntimeStateExpectedRevisionWithinLimit(
        expectedRevision,
        Number.MAX_SAFE_INTEGER,
        'runtime state expected revision'
    );
}

export function assertRuntimeStateUpsertExpectedRevision(
    expectedRevision: number
): void {
    assertRuntimeStateExpectedRevisionWithinLimit(
        expectedRevision,
        Number.MAX_SAFE_INTEGER - 1,
        'runtime state upsert expected revision'
    );
}

export function isRuntimeStatePrefixPageRepositoryLike(
    repository: RuntimeStateRepositoryLike
): repository is RuntimeStateRepositoryLike & RuntimeStatePrefixPageRepositoryLike {
    return 'findEntriesByPrefixPage' in repository;
}

function assertRuntimeStateExpectedRevisionWithinLimit(
    expectedRevision: number,
    maximum: number,
    label: string
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
