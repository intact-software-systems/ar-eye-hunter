import { filterDistributedRuns } from
    '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type {
    RecipeConsoleControlDistributedRunsSource,
    RecipeConsoleControlQueryProvenance,
} from '../control/control-api.ts';
import type { ControlQuerySnapshot, ControlQueryStatus } from
    '../control/control-query.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type RecipeConsoleHistoryProvenance = Readonly<{
    status: ControlQueryStatus;
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    freshness: 'current' | 'last-known' | 'unavailable';
    completeness: 'complete' | 'partial' | 'unavailable';
    receivedAtEpochMs?: number;
}>;

export type IndexedDistributedRun = Readonly<{
    run: ControlDistributedRunSnapshot;
    sourceOrdinal: number;
}>;

export type RecipeConsoleHistoryCollection = Readonly<{
    provenance: RecipeConsoleHistoryProvenance;
    counts: Readonly<{ available: number; total: number }>;
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
    query: ControlQuerySnapshot<
        ControlServerSnapshot,
        RecipeConsoleControlQueryProvenance
    >;
}>;

export function createRecipeConsoleHistoryCollection(
    input: RecipeConsoleHistoryInput,
): RecipeConsoleHistoryCollection {
    const distributedRuns = input.query.snapshot?.distributedRuns ?? [];
    const controlRuns = input.query.snapshot?.runs ?? [];
    const distributedIdCounts = new Map<string, number>();
    const sourceOrdinals = new Map<ControlDistributedRunSnapshot, number[]>();
    for (let sourceOrdinal = 0; sourceOrdinal < distributedRuns.length;
        sourceOrdinal += 1) {
        const run = distributedRuns[sourceOrdinal]!;
        distributedIdCounts.set(
            run.distributedRunId,
            (distributedIdCounts.get(run.distributedRunId) ?? 0) + 1,
        );
        const ordinals = sourceOrdinals.get(run);
        if (ordinals) ordinals.push(sourceOrdinal);
        else sourceOrdinals.set(run, [sourceOrdinal]);
    }
    const controlsById = groupControls(controlRuns);
    const occurrenceByRun = new Map<ControlDistributedRunSnapshot, number>();
    const entries = historyRuns(distributedRuns, input.urlState)
        .map(run => {
            const occurrence = occurrenceByRun.get(run) ?? 0;
            occurrenceByRun.set(run, occurrence + 1);
            return {
                run,
                sourceOrdinal: sourceOrdinals.get(run)?.[occurrence] ?? 0,
            };
        });
    const source = input.query.provenance?.distributedRunsSource ?? 'unavailable';
    return {
        provenance: historyProvenance(input.query),
        counts: { available: distributedRuns.length, total: entries.length },
        fingerprint: historyWindowFingerprint(source, input.urlState),
        work: {
            controlRunVisits: controlRuns.length,
            distributedRunVisits: distributedRuns.length,
        },
        entries,
        controlsById,
        distributedIdCounts,
    };
}

function historyRuns(
    runs: readonly ControlDistributedRunSnapshot[],
    state: RecipeConsoleUrlState,
): readonly ControlDistributedRunSnapshot[] {
    return hasCommittedHistoryFilter(state)
        ? filterDistributedRuns(runs, historyFilter(state))
        : [...runs].sort((left, right) =>
            right.updatedAtEpochMs - left.updatedAtEpochMs
        );
}

function hasCommittedHistoryFilter(state: RecipeConsoleUrlState): boolean {
    return [
        state.historyQuery,
        state.historyGroup,
        state.historyRecipeId,
        state.historyProfile,
        state.status,
        state.failureCategory,
    ].some(value => value?.trim()) ||
        state.from !== undefined || state.to !== undefined;
}

function historyFilter(state: RecipeConsoleUrlState) {
    return {
        query: state.historyQuery,
        groupId: state.historyGroup,
        recipeId: state.historyRecipeId,
        profile: state.historyProfile,
        status: state.status,
        failureCategory: state.failureCategory,
        fromEpochMs: state.from,
        toEpochMs: state.to,
    };
}

function historyWindowFingerprint(
    source: RecipeConsoleControlDistributedRunsSource,
    state: RecipeConsoleUrlState,
): string {
    return JSON.stringify([
        'history-window-v1',
        source,
        normalizedFingerprintText(state.historyQuery),
        normalizedFingerprintText(state.historyGroup),
        normalizedFingerprintText(state.historyRecipeId),
        normalizedFingerprintText(state.historyProfile),
        normalizedFingerprintText(state.status),
        normalizedFingerprintText(state.failureCategory),
        state.from ?? null,
        state.to ?? null,
    ]);
}

function normalizedFingerprintText(value: string | undefined): string | null {
    const normalized = value?.trim().toLocaleLowerCase('en-US');
    return normalized || null;
}

function historyProvenance(
    query: ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance>,
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
        receivedAtEpochMs: query.receivedAtEpochMs,
    };
}

function groupControls(
    runs: readonly ControlRunSnapshot[],
): ReadonlyMap<string, readonly ControlRunSnapshot[]> {
    const groups = new Map<string, ControlRunSnapshot[]>();
    for (const run of runs) {
        const group = groups.get(run.runId);
        if (group) group.push(run);
        else groups.set(run.runId, [run]);
    }
    return groups;
}
