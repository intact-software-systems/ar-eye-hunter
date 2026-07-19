import type { GroupRef } from '@shared/api/group-types.ts';
import {
    GROUP_TOPOLOGY_CONFIG_NAMESPACE,
    GROUP_TOPOLOGY_OVERRIDE_NAMESPACE,
    GroupTopologyConfigRepository,
    type GroupTopologyConfigGenerationSource,
    type GroupTopologyConfigLegacyKeyMigrationSource,
} from '../repositories/GroupTopologyConfigRepository.ts';
import type {
    GroupTopologyConfigGenerationTarget,
} from './group-topology-config-mutations.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';

export type GroupTopologyConfigGenerationBackfillResult = Readonly<{
    scanned: number;
    advanced: number;
}>;

type GroupTopologyConfigGenerationBackfillOptions = Readonly<{
    sleep?: (delayMs: number) => Promise<void>;
}>;

export async function backfillGroupTopologyConfigGenerationsForRef(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
    options: GroupTopologyConfigGenerationBackfillOptions = {},
): Promise<GroupTopologyConfigGenerationBackfillResult> {
    await assertNoPendingGroupTopologyConfigLegacyKeys(repository, groupRef);
    const sources = (await Promise.all([
        repository.findGenerationSource(groupRef, 'config'),
        repository.findGenerationSource(groupRef, 'override'),
    ])).filter((source): source is GroupTopologyConfigGenerationSource =>
        source !== undefined
    );
    return await backfillGroupTopologyConfigGenerationSources(
        repository,
        sources,
        options,
    );
}

export async function backfillAllGroupTopologyConfigGenerations(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigGenerationBackfillOptions = {},
): Promise<GroupTopologyConfigGenerationBackfillResult> {
    const sources = (await Promise.all([
        repository.listGenerationSources('config'),
        repository.listGenerationSources('override'),
    ])).flat();
    return await backfillGroupTopologyConfigGenerationSources(
        repository,
        sources,
        options,
    );
}

export async function migrateLegacyGroupTopologyConfigKeys(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigGenerationBackfillOptions &
        Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error(
            'Group topology config legacy key migration requires old writers to be stopped',
        );
    }
    await migrateAllGroupTopologyConfigLegacyKeys(repository, options);
}

async function assertNoPendingGroupTopologyConfigLegacyKeys(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
): Promise<void> {
    for (const target of ['config', 'override'] as const) {
        const source = await repository.findLegacyKeyMigrationSource(
            groupRef,
            target,
        );
        if (source) {
            throw new GroupTopologyConfigLegacyKeyMigrationRequiredError(
                source.entry.key,
                source.canonicalKey,
            );
        }
    }
}

async function migrateAllGroupTopologyConfigLegacyKeys(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigGenerationBackfillOptions,
): Promise<void> {
    const pageLimit = 100;
    for (const target of ['config', 'override'] as const) {
        let afterKey: string | undefined;
        while (true) {
            const page = await repository.listLegacyKeyMigrationSourcesPage(
                target,
                { ...(afterKey === undefined ? {} : { afterKey }), limit: pageLimit },
            );
            for (const source of page.sources) {
                await migrateGroupTopologyConfigLegacyKey(
                    repository,
                    source,
                    options,
                );
            }
            if (!page.hasMore || page.afterKey === undefined) break;
            afterKey = page.afterKey;
        }
    }
}

async function migrateGroupTopologyConfigLegacyKey(
    repository: GroupTopologyConfigRepository,
    source: GroupTopologyConfigLegacyKeyMigrationSource,
    options: GroupTopologyConfigGenerationBackfillOptions,
): Promise<void> {
    const runtime = requireOptimisticMigrationRuntime(repository.runtimeRepository);
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: options.sleep,
        });
        try {
            const migrated = await runtime.begin(async (transaction) => {
                const transactionRepository = new GroupTopologyConfigRepository(
                    transaction,
                );
                const current = await transactionRepository
                    .findLegacyKeyMigrationSource(
                        source.source.groupRef,
                        source.source.target,
                    );
                if (!current) return false;
                const destination = await transactionRepository
                    .findGenerationSourceEntry(
                        current.source.groupRef,
                        current.source.target,
                    );
                if (destination) {
                    if (
                        !sameNormalizedTopologySourceValue(
                            destination.value,
                            current.value,
                        )
                    ) {
                        throw new GroupTopologyConfigLegacyKeyMigrationError(
                            current.entry.key,
                            current.canonicalKey,
                        );
                    }
                } else {
                    const inserted = await transaction.insertIfAbsent(
                        topologySourceNamespace(current.source.target),
                        current.canonicalKey,
                        current.entry.value,
                        current.entry.expireAtTimestamp,
                    );
                    if (inserted.status === 'conflict') {
                        throw new RuntimeStateWriteConflictError();
                    }
                }
                const deleted = await transaction.deleteIfRevision(
                    topologySourceNamespace(current.source.target),
                    current.entry.key,
                    current.entry.revision,
                );
                if (deleted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
                return true;
            });
            if (!migrated) return;
            return;
        } catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
            lastConflict = error;
        }
    }
    throw new RuntimeStateRetryExhaustedError(
        lastConflict ?? new RuntimeStateWriteConflictError(),
    );
}

class GroupTopologyConfigLegacyKeyMigrationError extends Error {
    readonly code = 'group-topology-config-legacy-key-migration-conflict';

    constructor(sourceKey: string, destinationKey: string) {
        super(
            `Topology config legacy key migration destination differs: ${sourceKey} -> ${destinationKey}`,
        );
        this.name = 'GroupTopologyConfigLegacyKeyMigrationError';
    }
}

class GroupTopologyConfigLegacyKeyMigrationRequiredError extends Error {
    readonly code = 'group-topology-config-legacy-key-migration-required';

    constructor(sourceKey: string, destinationKey: string) {
        super(
            `Topology config legacy key requires offline migration: ${sourceKey} -> ${destinationKey}`,
        );
        this.name = 'GroupTopologyConfigLegacyKeyMigrationRequiredError';
    }
}

function requireOptimisticMigrationRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository'],
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isOptimisticMigrationRuntime(runtime)) {
        throw new Error(
            'Group topology config legacy key migration requires an optimistic transactional repository',
        );
    }
    return runtime;
}

function isOptimisticMigrationRuntime(
    runtime: GroupTopologyConfigRepository['runtimeRepository'],
): runtime is RuntimeStateOptimisticTransactionalRepositoryLike {
    return isRuntimeStateConditionalRepositoryLike(runtime) &&
        isRuntimeStateTransactionalRepositoryLike(runtime);
}

function topologySourceNamespace(
    target: GroupTopologyConfigGenerationTarget,
): string {
    return target === 'config'
        ? GROUP_TOPOLOGY_CONFIG_NAMESPACE
        : GROUP_TOPOLOGY_OVERRIDE_NAMESPACE;
}

function sameNormalizedTopologySourceValue(
    left: unknown,
    right: unknown,
): boolean {
    return JSON.stringify(toCanonicalJsonValue(left)) ===
        JSON.stringify(toCanonicalJsonValue(right));
}

function toCanonicalJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(toCanonicalJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, toCanonicalJsonValue(child)]),
    );
}

async function backfillGroupTopologyConfigGenerationSources(
    repository: GroupTopologyConfigRepository,
    sources: readonly GroupTopologyConfigGenerationSource[],
    options: GroupTopologyConfigGenerationBackfillOptions,
): Promise<GroupTopologyConfigGenerationBackfillResult> {
    let advanced = 0;
    for (const source of sources) {
        if (await backfillGroupTopologyConfigGeneration(repository, source, options)) {
            advanced += 1;
        }
    }
    return { scanned: sources.length, advanced };
}

async function backfillGroupTopologyConfigGeneration(
    repository: GroupTopologyConfigRepository,
    source: GroupTopologyConfigGenerationSource,
    options: GroupTopologyConfigGenerationBackfillOptions,
): Promise<boolean> {
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: options.sleep,
        });
        const current = await repository.findGenerationEntry(
            source.groupRef,
            source.target,
        );
        if ((current?.value.version ?? 0) >= source.version) return false;
        const committed = await repository.commitGeneration({
            groupRef: source.groupRef,
            target: source.target,
            version: source.version,
        }, current?.entry.revision ?? null);
        if (committed.status === 'accepted') return true;
        lastConflict = new RuntimeStateWriteConflictError();
    }
    throw new RuntimeStateRetryExhaustedError(
        lastConflict ?? new RuntimeStateWriteConflictError(),
    );
}
