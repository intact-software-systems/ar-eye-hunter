import { isControlSelectionIndexBoundToSnapshot } from
    './control-selection-index-binding.ts';
import {
    controlRunAgentRows,
    type ControlDistributedRunSnapshot,
    type ControlRunAgentRow,
} from './control-run-manager.ts';
import {
    distributedRecipeTargetRows,
    type DistributedRecipeTargetRow,
    type DistributedRunAgentProgressRow,
} from './distributed-recipes.ts';
import {
    deriveIndexedControlAgentBoardRows,
    type IndexedControlAgentBoardWork,
} from './control-agent-board-index.ts';
import {
    controlAgentBoardRowFromParticipations,
    controlAgentBoardRowSort,
    controlAgentRunParticipation,
    syntheticControlAgentRow,
} from './control-agent-board-model.ts';
import type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
    ControlAgentRunParticipation,
    DeriveControlAgentBoardRowsInput,
} from './control-agent-board-contract.ts';
export type {
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
    ControlAgentBoardTargetStatus,
    ControlAgentRunParticipation,
    DeriveControlAgentBoardRowsInput,
} from './control-agent-board-contract.ts';

export type ControlAgentBoardWork =
    | IndexedControlAgentBoardWork
    | Readonly<{
        indexed: false;
        fallback: boolean;
    }>;

const workByRows = new WeakMap<object, ControlAgentBoardWork>();

export function deriveControlAgentBoardRows(
    input: DeriveControlAgentBoardRowsInput,
): readonly ControlAgentBoardRow[] {
    if (input.selectionIndex && input.snapshot) {
        if (!isControlSelectionIndexBoundToSnapshot(
            input.snapshot,
            input.selectionIndex,
        )) {
            const fallback = deriveLegacyControlAgentBoardRows(input);
            workByRows.set(fallback, Object.freeze({
                indexed: false,
                fallback: true,
            }));
            return fallback;
        }
        const indexed = deriveIndexedControlAgentBoardRows(input);
        if (indexed) {
            workByRows.set(indexed.rows, indexed.work);
            return indexed.rows;
        }
        const fallback = deriveLegacyControlAgentBoardRows(input);
        workByRows.set(fallback, Object.freeze({ indexed: false, fallback: true }));
        return fallback;
    }
    const rows = deriveLegacyControlAgentBoardRows(input);
    workByRows.set(rows, Object.freeze({ indexed: false, fallback: false }));
    return rows;
}

export function controlAgentBoardWorkForTest(
    rows: readonly ControlAgentBoardRow[],
): ControlAgentBoardWork | undefined {
    return workByRows.get(rows);
}

function deriveLegacyControlAgentBoardRows(
    input: DeriveControlAgentBoardRowsInput,
): readonly ControlAgentBoardRow[] {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const scopedAgentIds = input.agentIds
        ? new Set(input.agentIds)
        : undefined;
    const agentRows = controlRunAgentRows(input.run)
        .filter((row) => !scopedAgentIds || scopedAgentIds.has(row.agentId));
    const targetRows = input.group
        ? distributedRecipeTargetRows({
            run: input.run,
            group: input.group,
            requiredCommandKinds: input.requiredCommandKinds ?? [],
            requiredRecipes: input.requiredRecipes ?? [],
            nowEpochMs,
            staleAfterMs: input.staleAfterMs,
        })
        : [];
    const targetRowsByAgentId = new Map(
        targetRows.map((row) => [row.agentId, row]),
    );
    const progressByAgentId = new Map(
        (input.monitorAgentProgress ?? []).map((row) => [row.agentId, row]),
    );
    const currentControlRunId =
        input.run?.runId ?? input.selectedDistributedRun?.controlRunId;
    const distributedRuns = uniqueRuns([
        ...(input.distributedRuns ?? []),
        ...(input.selectedDistributedRun ? [input.selectedDistributedRun] : []),
    ]).filter((run) =>
        currentControlRunId === undefined ||
        run.controlRunId === currentControlRunId
    );
    const selectedDistributedRunId =
        input.selectedDistributedRun?.distributedRunId;

    const rows = agentRows.map((agentRow) =>
        controlAgentBoardRow({
            agentRow,
            targetRow: targetRowsByAgentId.get(agentRow.agentId),
            nowEpochMs,
            runs: distributedRuns,
            selectedDistributedRunId,
            progressByAgentId,
            synthetic: false,
        })
    );

    const knownAgentIds = new Set(rows.map((row) => row.agentId));
    const syntheticRows = (input.selectedDistributedRun?.targetAgentIds ?? [])
        .filter((agentId) => !scopedAgentIds || scopedAgentIds.has(agentId))
        .filter((agentId) => !knownAgentIds.has(agentId))
        .map((agentId) =>
            controlAgentBoardRow({
                agentRow: syntheticControlAgentRow(agentId),
                targetRow: undefined,
                nowEpochMs,
                runs: distributedRuns,
                selectedDistributedRunId,
                progressByAgentId,
                synthetic: true,
            })
        );

    return [...rows, ...syntheticRows].sort(controlAgentBoardRowSort);
}

export function summarizeControlAgentBoardRows(
    rows: readonly ControlAgentBoardRow[],
): ControlAgentBoardSummary {
    return rows.reduce<ControlAgentBoardSummary>((summary, row) => ({
        total: summary.total + 1,
        connected: summary.connected + (row.connected ? 1 : 0),
        targetable: summary.targetable + (row.targetable ? 1 : 0),
        active: summary.active + (row.activeRuns.length > 0 ? 1 : 0),
        selected: summary.selected + (row.selectedRun ? 1 : 0),
        stale: summary.stale + (row.targetStatus === 'stale' ? 1 : 0),
        offline: summary.offline + (row.targetStatus === 'offline' ? 1 : 0),
        wrongGroup: summary.wrongGroup +
            (row.targetStatus === 'different-group' ? 1 : 0),
        missingIdentity: summary.missingIdentity +
            (row.targetStatus === 'missing-identity' ? 1 : 0),
        missingCapability: summary.missingCapability +
            (row.targetStatus === 'missing-crdt-runtime' ||
                    row.targetStatus === 'missing-crdt-transport'
                ? 1
                : 0),
        synthetic: summary.synthetic + (row.synthetic ? 1 : 0),
    }), {
        total: 0,
        connected: 0,
        targetable: 0,
        active: 0,
        selected: 0,
        stale: 0,
        offline: 0,
        wrongGroup: 0,
        missingIdentity: 0,
        missingCapability: 0,
        synthetic: 0,
    });
}

function controlAgentBoardRow(input: Readonly<{
    agentRow: ControlRunAgentRow;
    targetRow: DistributedRecipeTargetRow | undefined;
    nowEpochMs: number;
    runs: readonly ControlDistributedRunSnapshot[];
    selectedDistributedRunId?: string;
    progressByAgentId: ReadonlyMap<string, DistributedRunAgentProgressRow>;
    synthetic: boolean;
}>): ControlAgentBoardRow {
    const participations = input.runs
        .filter((run) => run.targetAgentIds.includes(input.agentRow.agentId))
        .map((run) =>
            controlAgentRunParticipation({
                run,
                agentId: input.agentRow.agentId,
                selected: run.distributedRunId ===
                    input.selectedDistributedRunId,
                progress: input.progressByAgentId.get(input.agentRow.agentId),
            })
        );
    return controlAgentBoardRowFromParticipations({
        agentRow: input.agentRow,
        targetRow: input.targetRow,
        nowEpochMs: input.nowEpochMs,
        participations,
        synthetic: input.synthetic,
    });
}

function uniqueRuns(
    runs: readonly ControlDistributedRunSnapshot[],
): readonly ControlDistributedRunSnapshot[] {
    const byId = new Map<string, ControlDistributedRunSnapshot>();
    runs.forEach((run) => {
        byId.set(run.distributedRunId, run);
    });
    return [...byId.values()];
}
