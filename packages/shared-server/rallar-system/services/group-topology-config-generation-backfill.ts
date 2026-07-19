import type { GroupRef } from '@shared/api/group-types.ts';
import {
    GroupTopologyConfigRepository,
    type GroupTopologyConfigGenerationSource,
} from '../repositories/GroupTopologyConfigRepository.ts';
import {
    DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS,
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';

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
