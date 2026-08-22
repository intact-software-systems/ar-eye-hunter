import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry
} from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
    type RuntimeStateOptimisticTransactionalRepositoryLike
} from '../../../../runtime-state/RuntimeStateRepository.ts';
import type { GroupTopologyConfigGenerationTarget } from '../mutation/group-topology-config-mutation-contracts.ts';
import type { GroupTopologyConfigLegacyKeyMigrationSource } from '../persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository } from '../persistence/group-topology-config-repository.ts';
import { groupTopologyConfigSourceNamespace } from '../persistence/group-topology-config-runtime-namespaces.ts';

interface GroupTopologyConfigLegacyKeyMigrationOptions {
    readonly oldWritersStopped: true;
    readonly sleep?: (delayMs: number) => Promise<void>;
}

export async function migrateLegacyGroupTopologyConfigKeys(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigLegacyKeyMigrationOptions
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error(
            'Group topology config legacy key migration requires old writers to be stopped'
        );
    }
    await migrateAllGroupTopologyConfigLegacyKeys(repository, options);
}

async function migrateAllGroupTopologyConfigLegacyKeys(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigLegacyKeyMigrationOptions
): Promise<void> {
    const pageLimit = 100;
    for (const target of ['config', 'override'] as const) {
        let afterKey: string | undefined;
        while (true) {
            const page = await repository.listLegacyKeyMigrationSourcesPage(target, {
                ...(afterKey === undefined ? {} : { afterKey }),
                limit: pageLimit
            });
            for (const source of page.sources) {
                await migrateGroupTopologyConfigLegacyKey(repository, source, options);
            }
            if (!page.hasMore || page.afterKey === undefined) {
                break;
            }
            afterKey = page.afterKey;
        }
    }
}

async function migrateGroupTopologyConfigLegacyKey(
    repository: GroupTopologyConfigRepository,
    source: GroupTopologyConfigLegacyKeyMigrationSource,
    options: GroupTopologyConfigLegacyKeyMigrationOptions
): Promise<void> {
    const runtime = requireOptimisticMigrationRuntime(repository.runtimeRepository);
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: options.sleep
        });
        try {
            const migrated = await migrateGroupTopologyConfigLegacyKeyAttempt(runtime, source);
            if (!migrated) {
                return;
            }
            return;
        }
        catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) {
                throw error;
            }
            lastConflict = error;
        }
    }
    throw new RuntimeStateRetryExhaustedError(lastConflict ?? new RuntimeStateWriteConflictError());
}

async function migrateGroupTopologyConfigLegacyKeyAttempt(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    source: GroupTopologyConfigLegacyKeyMigrationSource
): Promise<boolean> {
    return runtime.begin(async (transaction) => {
        const transactionRepository = new GroupTopologyConfigRepository(transaction);
        const current = await transactionRepository.findLegacyKeyMigrationSource(
            source.source.groupRef,
            source.source.target
        );
        if (!current) {
            return false;
        }
        const destination = await transactionRepository.findGenerationSourceEntry(
            current.source.groupRef,
            current.source.target
        );
        if (destination) {
            if (!sameNormalizedTopologySourceValue(destination.value, current.value)) {
                throw new GroupTopologyConfigLegacyKeyMigrationError(
                    current.entry.key,
                    current.canonicalKey
                );
            }
        }
        else {
            const inserted = await transaction.insertIfAbsent(
                groupTopologyConfigSourceNamespace(current.source.target),
                current.canonicalKey,
                current.entry.value,
                current.entry.expireAtTimestamp
            );
            if (inserted.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
        }
        const deleted = await transaction.deleteIfRevision(
            groupTopologyConfigSourceNamespace(current.source.target),
            current.entry.key,
            current.entry.revision
        );
        if (deleted.status === 'conflict') {
            throw new RuntimeStateWriteConflictError();
        }
        return true;
    });
}

function requireOptimisticMigrationRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository']
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isOptimisticMigrationRuntime(runtime)) {
        throw new Error(
            'Group topology config legacy key migration requires an optimistic transactional repository'
        );
    }
    return runtime;
}

function isOptimisticMigrationRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository']
): runtime is RuntimeStateOptimisticTransactionalRepositoryLike {
    return (
        isRuntimeStateConditionalRepositoryLike(runtime) &&
        isRuntimeStateTransactionalRepositoryLike(runtime)
    );
}

function sameNormalizedTopologySourceValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(toCanonicalJsonValue(left)) === JSON.stringify(toCanonicalJsonValue(right));
}

function toCanonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toCanonicalJsonValue);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, toCanonicalJsonValue(child)])
    );
}

class GroupTopologyConfigLegacyKeyMigrationError extends Error {
    readonly code = 'group-topology-config-legacy-key-migration-conflict';

    constructor(sourceKey: string, destinationKey: string) {
        super(
            `Topology config legacy key migration destination differs: ${sourceKey} -> ${destinationKey}`
        );
        this.name = 'GroupTopologyConfigLegacyKeyMigrationError';
    }
}
