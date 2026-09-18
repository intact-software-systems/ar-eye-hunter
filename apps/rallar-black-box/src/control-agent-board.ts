import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { computeIndexedControlAgentBoardRows } from './compute-indexed-control-agent-board-rows.ts';
import type {
    ComputeControlAgentBoardRowsInput,
    ControlAgentBoardRow,
    ControlAgentBoardSummary
} from './control-agent-board-contract.ts';
import {
    controlAgentBoardRowFromParticipations,
    controlAgentBoardRowSort,
    controlAgentRunParticipation,
    syntheticControlAgentRow
} from './control-agent-board-model.ts';
import { toControlRunAgentRows, type ControlRunAgentRow } from './control-run-manager/control-run-projections.ts';
import { isControlSelectionIndexBoundToSnapshot } from './control-selection-index-binding.ts';
import {
    distributedRecipeTargetRows,
    type DistributedRecipeTargetRow,
    type DistributedRunAgentProgressRow
} from './distributed-recipes.ts';
export type {
    ComputeControlAgentBoardRowsInput,
    ControlAgentBoardRow,
    ControlAgentBoardSummary,
    ControlAgentBoardTargetStatus,
    ControlAgentRunParticipation
} from './control-agent-board-contract.ts';

export function computeControlAgentBoardRows(
    input: ComputeControlAgentBoardRowsInput
): readonly ControlAgentBoardRow[] {
    if (
        input.selectionIndex && input.snapshot &&
        isControlSelectionIndexBoundToSnapshot(input.snapshot, input.selectionIndex)
    ) {
        const indexed = computeIndexedControlAgentBoardRows(input);
        if (indexed) {
            return indexed;
        }
    }
    return computeUnindexedControlAgentBoardRows(input);
}

function computeUnindexedControlAgentBoardRows(
    input: ComputeControlAgentBoardRowsInput
): readonly ControlAgentBoardRow[] {
    const nowEpochMs = input.nowEpochMs;
    const scopedAgentIds = input.agentIds
        ? new Set(input.agentIds)
        : undefined;
    const agentRows = toControlRunAgentRows(input.run)
        .filter((row) => !scopedAgentIds || scopedAgentIds.has(row.agentId));
    const targetRows = input.group
        ? distributedRecipeTargetRows({
            run: input.run,
            group: input.group,
            requiredCommandKinds: input.requiredCommandKinds,
            requiredRecipes: input.requiredRecipes,
            nowEpochMs,
            staleAfterMs: input.staleAfterMs
        })
        : [];
    const targetRowsByAgentId = new Map(
        targetRows.map((row) => [row.agentId, row])
    );
    const progressByAgentId = new Map(
        input.monitorAgentProgress.map((row) => [row.agentId, row])
    );
    const currentControlRunId = input.run?.runId ?? input.selectedDistributedRun?.controlRunId;
    const distributedRuns = toDistinctRuns([
        ...input.distributedRuns,
        ...(input.selectedDistributedRun ? [input.selectedDistributedRun] : [])
    ]).filter((run) =>
        currentControlRunId === undefined ||
        run.controlRunId === currentControlRunId
    );
    const selectedDistributedRunId = input.selectedDistributedRun?.distributedRunId;

    const rows = agentRows.map((agentRow) =>
        toControlAgentBoardRow({
            agentRow,
            targetRow: targetRowsByAgentId.get(agentRow.agentId),
            nowEpochMs,
            runs: distributedRuns,
            selectedDistributedRunId,
            progressByAgentId,
            synthetic: false
        })
    );

    const knownAgentIds = new Set(rows.map((row) => row.agentId));
    const syntheticRows = (input.selectedDistributedRun?.targetAgentIds ?? [])
        .filter((agentId) => !scopedAgentIds || scopedAgentIds.has(agentId))
        .filter((agentId) => !knownAgentIds.has(agentId))
        .map((agentId) =>
            toControlAgentBoardRow({
                agentRow: syntheticControlAgentRow(agentId),
                targetRow: undefined,
                nowEpochMs,
                runs: distributedRuns,
                selectedDistributedRunId,
                progressByAgentId,
                synthetic: true
            })
        );

    return [...rows, ...syntheticRows].sort(controlAgentBoardRowSort);
}

export function computeControlAgentBoardSummary(
    rows: readonly ControlAgentBoardRow[]
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
        synthetic: summary.synthetic + (row.synthetic ? 1 : 0)
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
        synthetic: 0
    });
}

function toControlAgentBoardRow(
    input: Readonly<{
        agentRow: ControlRunAgentRow;
        targetRow: DistributedRecipeTargetRow | undefined;
        nowEpochMs: number;
        runs: readonly ControlDistributedRunSnapshot[];
        /** `undefined` when the operator has selected no distributed run. */
        selectedDistributedRunId: string | undefined;
        progressByAgentId: ReadonlyMap<string, DistributedRunAgentProgressRow>;
        synthetic: boolean;
    }>
): ControlAgentBoardRow {
    const participations = input.runs
        .filter((run) => run.targetAgentIds.includes(input.agentRow.agentId))
        .map((run) =>
            controlAgentRunParticipation({
                run,
                agentId: input.agentRow.agentId,
                selected: run.distributedRunId ===
                    input.selectedDistributedRunId,
                progress: input.progressByAgentId.get(input.agentRow.agentId)
            })
        );
    return controlAgentBoardRowFromParticipations({
        agentRow: input.agentRow,
        targetRow: input.targetRow,
        nowEpochMs: input.nowEpochMs,
        participations,
        synthetic: input.synthetic
    });
}

function toDistinctRuns(
    runs: readonly ControlDistributedRunSnapshot[]
): readonly ControlDistributedRunSnapshot[] {
    const byId = new Map<string, ControlDistributedRunSnapshot>();
    runs.forEach((run) => {
        byId.set(run.distributedRunId, run);
    });
    return [...byId.values()];
}
