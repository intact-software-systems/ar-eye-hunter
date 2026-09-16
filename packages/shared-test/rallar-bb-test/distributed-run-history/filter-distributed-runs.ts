import type { ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import { toDistributedFailureExplanation } from '../distributed-run-analysis/to-distributed-failure-explanation.ts';
import { distributedRunRecordedFailures } from '../distributed-run-observation/distributed-run-failure-rows.ts';
import {
    toDistributedRunHistoryManifest,
    toHistoryManifestText
} from './project-distributed-run-history-labels.ts';
import { toDistributedRunRecipeSelectionId } from './to-distributed-run-recipe-selection-id.ts';

export type DistributedRunHistoryFilter = Readonly<{
    query?: string;
    groupId?: string;
    recipeId?: string;
    profile?: string;
    user?: string;
    status?: string;
    failureType?: string;
    failureCategory?: string;
    fromEpochMs?: number;
    toEpochMs?: number;
}>;

export function filterDistributedRuns(
    runs: readonly ControlDistributedRunSnapshot[],
    filter: DistributedRunHistoryFilter
): readonly ControlDistributedRunSnapshot[] {
    const normalized = {
        filter,
        query: toNormalizedFilterText(filter.query),
        groupId: toNormalizedFilterText(filter.groupId),
        recipeId: toNormalizedFilterText(filter.recipeId),
        profile: toNormalizedFilterText(filter.profile),
        user: toNormalizedFilterText(filter.user),
        status: toNormalizedFilterText(filter.status),
        failureType: toNormalizedFilterText(filter.failureType),
        failureCategory: toNormalizedFilterText(filter.failureCategory)
    };

    return [...runs]
        .filter((run) => matchesDistributedRunFilter(run, normalized))
        .sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);
}

interface NormalizedDistributedRunFilter {
    readonly filter: DistributedRunHistoryFilter;
    readonly query: string;
    readonly groupId: string;
    readonly recipeId: string;
    readonly profile: string;
    readonly user: string;
    readonly status: string;
    readonly failureType: string;
    readonly failureCategory: string;
}

function matchesDistributedRunFilter(
    run: ControlDistributedRunSnapshot,
    normalized: NormalizedDistributedRunFilter
): boolean {
    const { filter, query, groupId, recipeId, profile, user, status, failureType, failureCategory } = normalized;
    const manifest = toDistributedRunHistoryManifest(run);
    if (status && toNormalizedFilterText(run.state) !== status) {
        return false;
    }
    if (
        groupId &&
        !toNormalizedFilterText(toHistoryManifestText(manifest.group.groupId)).includes(groupId)
    ) {
        return false;
    }
    if (
        recipeId &&
        !manifest.recipes.some(({ selection, index }) =>
            toNormalizedFilterText(toDistributedRunRecipeSelectionId(selection, index)).includes(recipeId)
        )
    ) {
        return false;
    }
    if (
        profile &&
        !manifest.recipes.some(({ selection }) =>
            toNormalizedFilterText(toHistoryManifestText(selection.profile)).includes(profile)
        )
    ) {
        return false;
    }
    if (
        user &&
        !toNormalizedFilterText(toHistoryManifestText(manifest.metadata.createdBy)).includes(user)
    ) {
        return false;
    }
    if (filter.fromEpochMs !== undefined && run.createdAtEpochMs < filter.fromEpochMs) {
        return false;
    }
    if (filter.toEpochMs !== undefined && run.createdAtEpochMs > filter.toEpochMs) {
        return false;
    }
    if (failureType && !matchesDistributedRunFailureType(run, failureType)) {
        return false;
    }
    if (
        failureCategory &&
        !matchesDistributedRunFailureCategory(run, failureCategory)
    ) {
        return false;
    }
    if (!query) {
        return true;
    }
    return toDistributedRunSearchText(run).includes(query);
}

function matchesDistributedRunFailureType(
    run: ControlDistributedRunSnapshot,
    failureType: string
): boolean {
    const failures = [
        ...run.rollup.failures.map((failure) =>
            `${failure.kind} ${failure.state} ${failure.error?.code ?? ''} ${failure.error?.message ?? ''}`
        ),
        run.error ? `run ${run.error.code} ${run.error.message}` : ''
    ].join(' ').toLowerCase();
    if (failureType === 'any') {
        return failures.trim().length > 0;
    }
    return failures.includes(failureType);
}

function matchesDistributedRunFailureCategory(
    run: ControlDistributedRunSnapshot,
    category: string
): boolean {
    const failures = distributedRunRecordedFailures(run);
    if (category === 'any') {
        return failures.length > 0;
    }
    return failures.some((failure) => toDistributedFailureExplanation(failure).category === category);
}

function toDistributedRunSearchText(run: ControlDistributedRunSnapshot): string {
    const manifest = toDistributedRunHistoryManifest(run);
    return [
        run.distributedRunId,
        run.controlRunId,
        run.state,
        toHistoryManifestText(manifest.record.displayName),
        toHistoryManifestText(manifest.group.applicationId),
        toHistoryManifestText(manifest.group.workspaceId),
        toHistoryManifestText(manifest.group.groupId),
        toHistoryManifestText(manifest.metadata.createdBy),
        ...run.targetAgentIds,
        ...manifest.recipes.flatMap(({ selection, index }) => [
            toDistributedRunRecipeSelectionId(selection, index),
            toHistoryManifestText(selection.profile),
            toHistoryManifestText(selection.role)
        ]),
        ...toDistributedRunFailureSignatures(run)
    ].filter(Boolean).join(' ').toLowerCase();
}

export function toDistributedRunFailureSignatures(run: ControlDistributedRunSnapshot): readonly string[] {
    const signatures = run.rollup.failures.map((failure) =>
        `${failure.kind}:${failure.key}:${failure.state}:${failure.error?.code ?? ''}:${failure.error?.message ?? ''}`
    );
    if (run.error) {
        signatures.push(`run:${run.error.code}:${run.error.message}`);
    }
    return signatures.sort();
}

function toNormalizedFilterText(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}
