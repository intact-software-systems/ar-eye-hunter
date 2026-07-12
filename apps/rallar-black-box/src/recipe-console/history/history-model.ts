import {
    filterDistributedRuns,
    projectDistributedRunHistoryLabels,
    type DistributedRunHistoryLabels,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { ControlRetentionCandidate } from
    '@shared-test/rallar-bb-test/control-retention.ts';
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
import {
    buildTuneRunCatalog,
    type TuneQuarantineCode, type TuneQuarantinedRun,
} from '../tune/tune-run-catalog.ts';
import {
    historyRowSelectionActions, type HistoryRowSelectionActions,
} from './history-url-patches.ts';
export const RECIPE_CONSOLE_HISTORY_ROW_LIMIT = 100;
export type RecipeConsoleHistoryProvenance = Readonly<{
    status: ControlQueryStatus;
    distributedRunsSource: RecipeConsoleControlDistributedRunsSource;
    freshness: 'current' | 'last-known' | 'unavailable';
    completeness: 'complete' | 'partial' | 'unavailable';
    receivedAtEpochMs?: number;
}>;
export type RecipeConsoleHistoryRow = Readonly<{
    key: string;
    distributedRunId: string;
    controlRunId: string;
    state: ControlDistributedRunSnapshot['state'];
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    labels: DistributedRunHistoryLabels;
    pairStatus: 'paired' | 'missing' | 'ambiguous';
    controlStatus: 'paired-connected' | 'paired-idle' | 'missing' | 'ambiguous';
    agentCount: number;
    connectedAgentCount: number;
    controlRun?: ControlRunSnapshot;
    quarantined: boolean;
    quarantineCodes: readonly TuneQuarantineCode[];
    issues: readonly string[];
    actions: HistoryRowSelectionActions;
}>;
export type RecipeConsoleHistoryModel = Readonly<{
    provenance: RecipeConsoleHistoryProvenance;
    counts: Readonly<{
        available: number;
        total: number;
        rendered: number;
        omitted: number;
    }>;
    rows: readonly RecipeConsoleHistoryRow[];
}>;
export type HistoryRetentionCandidateRow = Readonly<{ key: string }> &
    ControlRetentionCandidate;
export function deriveRecipeConsoleHistoryModel(input: Readonly<{
    urlState: RecipeConsoleUrlState;
    query: ControlQuerySnapshot<
        ControlServerSnapshot,
        RecipeConsoleControlQueryProvenance
    >;
}>): RecipeConsoleHistoryModel {
    const distributedRuns = input.query.snapshot?.distributedRuns ?? [];
    const controlRuns = input.query.snapshot?.runs ?? [];
    const filtered = filterDistributedRuns(distributedRuns, {
        query: input.urlState.historyQuery,
        groupId: input.urlState.historyGroup,
        recipeId: input.urlState.historyRecipeId,
        profile: input.urlState.historyProfile,
        status: input.urlState.status,
        failureCategory: input.urlState.failureCategory,
        fromEpochMs: input.urlState.from,
        toEpochMs: input.urlState.to,
    });
    const visible = filtered.slice(0, RECIPE_CONSOLE_HISTORY_ROW_LIMIT);
    const distributedIdCounts = countDistributedRunIds(distributedRuns);
    const catalogRuns = visible.filter(run =>
        distributedIdCounts.get(run.distributedRunId) === 1
    );
    const controlsById = groupControls(controlRuns);
    const catalog = buildTuneRunCatalog({
        distributedRuns: catalogRuns,
        controlRuns: boundedCatalogControls(catalogRuns, controlsById),
        includePerformanceEvidence: false,
    });
    const optionById = new Map(catalog.options.map(option => [
        option.distributedRunId,
        option,
    ]));
    const rows = visible.map((run, index): RecipeConsoleHistoryRow => {
        const quarantine = quarantineFor(
            catalog.quarantined,
            run,
            distributedIdCounts,
        );
        const option = quarantine ? undefined : optionById.get(run.distributedRunId);
        const controls = controlsById.get(run.controlRunId) ?? [];
        const pairStatus = controls.length === 1
            ? 'paired' as const
            : controls.length === 0 ? 'missing' as const : 'ambiguous' as const;
        const controlRun = pairStatus === 'paired' ? controls[0] : undefined;
        const connectedAgentCount = controlRun?.agents.filter(agent =>
            agent.connected
        ).length ?? 0;
        return {
            key: `history-row:${index}`,
            distributedRunId: run.distributedRunId,
            controlRunId: run.controlRunId,
            state: run.state,
            createdAtEpochMs: run.createdAtEpochMs,
            updatedAtEpochMs: run.updatedAtEpochMs,
            labels: projectDistributedRunHistoryLabels(run),
            pairStatus,
            controlStatus: pairStatus === 'paired'
                ? connectedAgentCount > 0 ? 'paired-connected' : 'paired-idle'
                : pairStatus,
            agentCount: controlRun?.agents.length ?? 0,
            connectedAgentCount,
            controlRun,
            quarantined: option === undefined && quarantine !== undefined,
            quarantineCodes: quarantine?.codes ?? [],
            issues: quarantine?.issues ?? [],
            actions: historyRowSelectionActions(option),
        };
    });
    return {
        provenance: historyProvenance(input.query),
        counts: {
            available: distributedRuns.length,
            total: filtered.length,
            rendered: rows.length,
            omitted: filtered.length - rows.length,
        },
        rows,
    };
}
export function projectHistoryRetentionCandidateRows(
    candidates: readonly ControlRetentionCandidate[],
): readonly HistoryRetentionCandidateRow[] {
    return candidates.map((candidate, index) => ({
        key: `retention-candidate:${index}`,
        ...candidate,
        distributedRuns: candidate.distributedRuns.map(run => ({ ...run })),
        fleetReportIds: [...candidate.fleetReportIds],
    }));
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
function countDistributedRunIds(
    runs: readonly ControlDistributedRunSnapshot[],
): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const run of runs) {
        counts.set(run.distributedRunId, (counts.get(run.distributedRunId) ?? 0) + 1);
    }
    return counts;
}
function boundedCatalogControls(
    runs: readonly ControlDistributedRunSnapshot[],
    controlsById: ReadonlyMap<string, readonly ControlRunSnapshot[]>,
): readonly ControlRunSnapshot[] {
    const controls: ControlRunSnapshot[] = [];
    const visited = new Set<string>();
    for (const run of runs) {
        if (visited.has(run.controlRunId)) continue;
        visited.add(run.controlRunId);
        controls.push(...(controlsById.get(run.controlRunId) ?? []).slice(0, 2));
    }
    return controls;
}
function quarantineFor(
    quarantined: readonly TuneQuarantinedRun[],
    run: ControlDistributedRunSnapshot,
    distributedIdCounts: ReadonlyMap<string, number>,
): TuneQuarantinedRun | undefined {
    if ((distributedIdCounts.get(run.distributedRunId) ?? 0) > 1) {
        return {
            key: 'history-duplicate',
            distributedRunId: run.distributedRunId,
            codes: ['ambiguous-run'],
            issues: ['Duplicate distributed run identity is ambiguous.'],
        };
    }
    return quarantined.find(candidate =>
        candidate.distributedRunId === run.distributedRunId &&
        (candidate.controlRunId === undefined || candidate.controlRunId === run.controlRunId)
    );
}
