import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    filterDistributedRuns,
    type DistributedRunHistoryFilter
} from '@shared-test/rallar-bb-test/distributed-run-history/filter-distributed-runs.ts';
import type {
    RecipeConsoleControlDistributedRunsSource,
    RecipeConsoleControlQueryProvenance
} from '../control/control-api.ts';
import type { ControlQuerySnapshot, ControlQueryStatus } from '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type RecipeConsoleHistoryProvenance = Readonly<{
    status: ControlQueryStatus;
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    freshness: 'current' | 'last-known' | 'unavailable';
    completeness: 'complete' | 'partial' | 'unavailable';
    /** Absent until the control query has received a snapshot. */
    receivedAtEpochMs?: number;
}>;

export type IndexedDistributedRun = Readonly<{
    run: ControlDistributedRunSnapshot;
    sourceOrdinal: number;
}>;

export type RecipeConsoleHistoryCollection = Readonly<{
    provenance: RecipeConsoleHistoryProvenance;
    counts: Readonly<{ available: number; total: number; }>;
    fingerprint: string;
    work: Readonly<{
        controlRunVisits: number;
        distributedRunVisits: number;
    }>;
    entries: readonly IndexedDistributedRun[];
    controlsById: ReadonlyMap<string, readonly ControlRunSnapshot[]>;
    distributedIdCounts: ReadonlyMap<string, number>;
}>;

export type RecipeConsoleHistoryInput = Readonly<{
    urlState: RecipeConsoleUrlState;
    query: ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance>;
}>;

export function createRecipeConsoleHistoryCollection(
    input: RecipeConsoleHistoryInput
): RecipeConsoleHistoryCollection {
    const distributedRuns = input.query.snapshot?.distributedRuns ?? [];
    const controlRuns = input.query.snapshot?.runs ?? [];
    const distributedIdCounts = new Map<string, number>();
    const sourceOrdinals = new Map<ControlDistributedRunSnapshot, number[]>();
    for (let sourceOrdinal = 0; sourceOrdinal < distributedRuns.length; sourceOrdinal += 1) {
        const run = distributedRuns[sourceOrdinal]!;
        distributedIdCounts.set(
            run.distributedRunId,
            (distributedIdCounts.get(run.distributedRunId) ?? 0) + 1
        );
        const ordinals = sourceOrdinals.get(run);
        if (ordinals) {
            ordinals.push(sourceOrdinal);
        }
        else {
            sourceOrdinals.set(run, [sourceOrdinal]);
        }
    }
    const controlsById = toControlRunsByRunId(controlRuns);
    const occurrenceByRun = new Map<ControlDistributedRunSnapshot, number>();
    const entries = resolveHistoryRuns(distributedRuns, input.urlState)
        .map((run) => {
            const occurrence = occurrenceByRun.get(run) ?? 0;
            occurrenceByRun.set(run, occurrence + 1);
            return {
                run,
                sourceOrdinal: sourceOrdinals.get(run)?.[occurrence] ?? 0
            };
        });
    const source = input.query.provenance?.distributedRunsSource ?? 'unavailable';
    return {
        provenance: toHistoryProvenance(input.query),
        counts: { available: distributedRuns.length, total: entries.length },
        fingerprint: computeHistoryWindowFingerprint(source, input.urlState),
        work: {
            controlRunVisits: controlRuns.length,
            distributedRunVisits: distributedRuns.length
        },
        entries,
        controlsById,
        distributedIdCounts
    };
}

function resolveHistoryRuns(
    runs: readonly ControlDistributedRunSnapshot[],
    state: RecipeConsoleUrlState
): readonly ControlDistributedRunSnapshot[] {
    return hasCommittedHistoryFilter(state)
        ? filterDistributedRuns(runs, toHistoryFilter(state))
        : [...runs].sort((left, right) => right.updatedAtEpochMs - left.updatedAtEpochMs);
}

function hasCommittedHistoryFilter(state: RecipeConsoleUrlState): boolean {
    return [
        state.historyQuery,
        state.historyGroup,
        state.historyRecipeId,
        state.historyProfile,
        state.status,
        state.failureCategory
    ].some((value) => value?.trim()) ||
        state.from !== undefined || state.to !== undefined;
}

function toHistoryFilter(state: RecipeConsoleUrlState): DistributedRunHistoryFilter {
    return {
        query: state.historyQuery,
        groupId: state.historyGroup,
        recipeId: state.historyRecipeId,
        profile: state.historyProfile,
        status: state.status,
        failureCategory: state.failureCategory,
        fromEpochMs: state.from,
        toEpochMs: state.to
    };
}

function computeHistoryWindowFingerprint(
    source: RecipeConsoleControlDistributedRunsSource,
    state: RecipeConsoleUrlState
): string {
    return JSON.stringify([
        'history-window-v1',
        source,
        toNormalizedFingerprintText(state.historyQuery),
        toNormalizedFingerprintText(state.historyGroup),
        toNormalizedFingerprintText(state.historyRecipeId),
        toNormalizedFingerprintText(state.historyProfile),
        toNormalizedFingerprintText(state.status),
        toNormalizedFingerprintText(state.failureCategory),
        state.from ?? null,
        state.to ?? null
    ]);
}

function toNormalizedFingerprintText(value: string | undefined): string | null {
    const normalized = value?.trim().toLocaleLowerCase('en-US');
    return normalized || null;
}

function toHistoryProvenance(
    query: ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance>
): RecipeConsoleHistoryProvenance {
    const source = query.provenance?.distributedRunsSource ?? 'unavailable';
    const hasEvidence = source !== 'unavailable' &&
        query.snapshot?.distributedRuns !== undefined;
    return {
        status: query.status,
        distributedRunsSource: source,
        freshness: !hasEvidence
            ? 'unavailable'
            : query.status === 'live' || query.status === 'partial'
            ? 'current'
            : 'last-known',
        completeness: !hasEvidence
            ? 'unavailable'
            : query.completeness ?? 'partial',
        receivedAtEpochMs: query.receivedAtEpochMs
    };
}

function toControlRunsByRunId(
    runs: readonly ControlRunSnapshot[]
): ReadonlyMap<string, readonly ControlRunSnapshot[]> {
    const groups = new Map<string, ControlRunSnapshot[]>();
    for (const run of runs) {
        const group = groups.get(run.runId);
        if (group) {
            group.push(run);
        }
        else {
            groups.set(run.runId, [run]);
        }
    }
    return groups;
}
