import type { GroupRef } from '@shared/api/group-types.ts';

import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry
} from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { GroupTopologyConfigGenerationSource } from '../persistence/group-topology-config-repository-contracts.ts';
import { GroupTopologyConfigRepository } from '../persistence/group-topology-config-repository.ts';

export interface GroupTopologyConfigGenerationBackfillResult {
    readonly scanned: number;
    readonly advanced: number;
}

interface GroupTopologyConfigGenerationBackfillOptions {
    readonly sleep?: (delayMs: number) => Promise<void>;
}

export async function backfillGroupTopologyConfigGenerationsForRef(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef,
    options: GroupTopologyConfigGenerationBackfillOptions = {}
): Promise<GroupTopologyConfigGenerationBackfillResult> {
    await assertNoPendingGroupTopologyConfigLegacyKeys(repository, groupRef);
    const sources = (
        await Promise.all([
            repository.findGenerationSource(groupRef, 'config'),
            repository.findGenerationSource(groupRef, 'override')
        ])
    ).filter((source): source is GroupTopologyConfigGenerationSource => source !== undefined);
    return await backfillGroupTopologyConfigGenerationSources(repository, sources, options);
}

export async function backfillAllGroupTopologyConfigGenerations(
    repository: GroupTopologyConfigRepository,
    options: GroupTopologyConfigGenerationBackfillOptions = {}
): Promise<GroupTopologyConfigGenerationBackfillResult> {
    const sources = (
        await Promise.all([
            repository.listGenerationSources('config'),
            repository.listGenerationSources('override')
        ])
    ).flat();
    return await backfillGroupTopologyConfigGenerationSources(repository, sources, options);
}

async function assertNoPendingGroupTopologyConfigLegacyKeys(
    repository: GroupTopologyConfigRepository,
    groupRef: GroupRef
): Promise<void> {
    for (const target of ['config', 'override'] as const) {
        const source = await repository.findLegacyKeyMigrationSource(groupRef, target);
        if (source) {
            throw new GroupTopologyConfigLegacyKeyMigrationRequiredError(
                source.entry.key,
                source.canonicalKey
            );
        }
    }
}

async function backfillGroupTopologyConfigGenerationSources(
    repository: GroupTopologyConfigRepository,
    sources: readonly GroupTopologyConfigGenerationSource[],
    options: GroupTopologyConfigGenerationBackfillOptions
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
    options: GroupTopologyConfigGenerationBackfillOptions
): Promise<boolean> {
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt += 1) {
        await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: options.sleep
        });
        const current = await repository.findGenerationEntry(source.groupRef, source.target);
        if ((current?.value.version ?? 0) >= source.version) {
            return false;
        }
        const committed = await repository.commitGeneration(
            {
                groupRef: source.groupRef,
                target: source.target,
                version: source.version
            },
            current?.entry.revision ?? null
        );
        if (committed.status === 'accepted') {
            return true;
        }
        lastConflict = new RuntimeStateWriteConflictError();
    }
    throw new RuntimeStateRetryExhaustedError(lastConflict ?? new RuntimeStateWriteConflictError());
}

class GroupTopologyConfigLegacyKeyMigrationRequiredError extends Error {
    readonly code = 'group-topology-config-legacy-key-migration-required';

    constructor(sourceKey: string, destinationKey: string) {
        super(
            `Topology config legacy key requires offline migration: ${sourceKey} -> ${destinationKey}`
        );
        this.name = 'GroupTopologyConfigLegacyKeyMigrationRequiredError';
    }
}
