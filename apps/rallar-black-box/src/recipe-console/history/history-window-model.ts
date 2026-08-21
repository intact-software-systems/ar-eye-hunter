import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    projectDistributedRunHistoryLabels,
    type DistributedRunHistoryLabels
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { buildTuneRunCatalog, type TuneQuarantineCode, type TuneQuarantinedRun } from '../tune/tune-run-catalog.ts';
import { historyRowSelectionActions, type HistoryRowSelectionActions } from './history-url-patches.ts';
import type { RecipeConsoleHistoryCollection, RecipeConsoleHistoryProvenance } from './history-window-collection.ts';

export const RECIPE_CONSOLE_HISTORY_WINDOW_SIZE = 80;

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

export type RecipeConsoleHistoryProjectionWork = Readonly<{
    projectedRows: number;
    labelProjections: number;
    catalogRunProjections: number;
    actionProjections: number;
    controlAgentVisits: number;
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
    work?: RecipeConsoleHistoryProjectionWork;
}>;

export function deriveRecipeConsoleHistoryWindow(
    collection: RecipeConsoleHistoryCollection,
    requestedStartIndex: number
): RecipeConsoleHistoryModel {
    const startIndex = boundedWindowStart(
        requestedStartIndex,
        collection.counts.total
    );
    const visible = collection.entries.slice(
        startIndex,
        startIndex + RECIPE_CONSOLE_HISTORY_WINDOW_SIZE
    );
    const catalogRuns = visible
        .map((entry) => entry.run)
        .filter((run) => collection.distributedIdCounts.get(run.distributedRunId) === 1);
    const catalog = buildTuneRunCatalog({
        distributedRuns: catalogRuns,
        controlRuns: boundedCatalogControls(catalogRuns, collection.controlsById),
        includePerformanceEvidence: false
    });
    const optionById = new Map(catalog.options.map((option) => [
        option.distributedRunId,
        option
    ]));
    const work = {
        projectedRows: 0,
        labelProjections: 0,
        catalogRunProjections: catalogRuns.length,
        actionProjections: 0,
        controlAgentVisits: 0
    };
    const rows = visible.map((entry): RecipeConsoleHistoryRow => {
        const run = entry.run;
        const quarantine = quarantineFor(
            catalog.quarantined,
            run,
            collection.distributedIdCounts
        );
        const option = quarantine ? undefined : optionById.get(run.distributedRunId);
        const controls = collection.controlsById.get(run.controlRunId) ?? [];
        const pairStatus = controls.length === 1
            ? 'paired' as const
            : controls.length === 0
            ? 'missing' as const
            : 'ambiguous' as const;
        const controlRun = pairStatus === 'paired' ? controls[0] : undefined;
        const connectedAgentCount = connectedAgents(controlRun, work);
        work.projectedRows += 1;
        work.labelProjections += 1;
        work.actionProjections += 1;
        return {
            key: `history-row:${entry.sourceOrdinal}`,
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
            actions: historyRowSelectionActions(option)
        };
    });
    return {
        provenance: collection.provenance,
        counts: {
            available: collection.counts.available,
            total: collection.counts.total,
            rendered: rows.length,
            omitted: collection.counts.total - rows.length
        },
        rows,
        work: Object.freeze({ ...work })
    };
}

function boundedWindowStart(requested: number, total: number): number {
    const normalized = Number.isFinite(requested)
        ? Math.max(0, Math.floor(requested))
        : 0;
    const pageStart = Math.floor(normalized / RECIPE_CONSOLE_HISTORY_WINDOW_SIZE) *
        RECIPE_CONSOLE_HISTORY_WINDOW_SIZE;
    const lastStart = total === 0 ? 0 : Math.floor(
        (total - 1) /
            RECIPE_CONSOLE_HISTORY_WINDOW_SIZE
    ) * RECIPE_CONSOLE_HISTORY_WINDOW_SIZE;
    return Math.min(pageStart, lastStart);
}

function boundedCatalogControls(
    runs: readonly ControlDistributedRunSnapshot[],
    controlsById: ReadonlyMap<string, readonly ControlRunSnapshot[]>
): readonly ControlRunSnapshot[] {
    const controls: ControlRunSnapshot[] = [];
    const visited = new Set<string>();
    for (const run of runs) {
        if (visited.has(run.controlRunId)) {
            continue;
        }
        visited.add(run.controlRunId);
        controls.push(...(controlsById.get(run.controlRunId) ?? []).slice(0, 2));
    }
    return controls;
}

function quarantineFor(
    quarantined: readonly TuneQuarantinedRun[],
    run: ControlDistributedRunSnapshot,
    distributedIdCounts: ReadonlyMap<string, number>
): TuneQuarantinedRun | undefined {
    if ((distributedIdCounts.get(run.distributedRunId) ?? 0) > 1) {
        return {
            key: 'history-duplicate',
            distributedRunId: run.distributedRunId,
            codes: ['ambiguous-run'],
            issues: ['Duplicate distributed run identity is ambiguous.']
        };
    }
    return quarantined.find((candidate) =>
        candidate.distributedRunId === run.distributedRunId &&
        (candidate.controlRunId === undefined || candidate.controlRunId === run.controlRunId)
    );
}

function connectedAgents(
    controlRun: ControlRunSnapshot | undefined,
    work: { controlAgentVisits: number; }
): number {
    let connected = 0;
    for (const agent of controlRun?.agents ?? []) {
        work.controlAgentVisits += 1;
        if (agent.connected) {
            connected += 1;
        }
    }
    return connected;
}
