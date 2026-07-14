import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    rebindControlRunFromSelectionIndex,
    rebindDistributedRunPairFromSelectionIndex,
    type ControlSnapshotSelectionIndex,
} from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import { isControlSelectionIndexBoundToSnapshot } from
    '../../control-selection-index-binding.ts';
import type {
    MonitorWorkspaceContext,
    MonitorWorkspaceState,
} from './monitor-workspace-state.ts';

export type MonitorWorkspaceReconciliationWork = Readonly<{
    indexed: boolean;
    fallback: boolean;
}>;

export type ResolvedMonitorContextRuns = Readonly<{
    controlRun?: ControlRunSnapshot;
    distributedRun?: ControlDistributedRunSnapshot;
    indexed: boolean;
    fallback: boolean;
}>;

const workByState = new WeakMap<object, MonitorWorkspaceReconciliationWork>();

export function resolveMonitorContextRuns(
    snapshot: ControlServerSnapshot | undefined,
    context: MonitorWorkspaceContext,
    selectionIndex: ControlSnapshotSelectionIndex | undefined,
): ResolvedMonitorContextRuns {
    const legacy = (fallback: boolean): ResolvedMonitorContextRuns => ({
        controlRun: snapshot?.runs.find(run => run.runId === context.controlRunId),
        distributedRun: snapshot?.distributedRuns?.find(run =>
            run.distributedRunId === context.distributedRunId &&
            run.controlRunId === context.controlRunId
        ),
        indexed: false,
        fallback,
    });
    if (!snapshot || !selectionIndex) return legacy(false);
    if (
        !isControlSelectionIndexBoundToSnapshot(snapshot, selectionIndex) ||
        selectionIndex.controlRunIdsByOrdinal.length !== snapshot.runs.length ||
        selectionIndex.distributedRunIdsByOrdinal.length !==
            (snapshot.distributedRuns?.length ?? 0) ||
        selectionIndex.hasDistributedRunCollection !==
            (snapshot.distributedRuns !== undefined)
    ) return legacy(true);

    const hasControlRun = selectionIndex.firstControlRunOrdinalById.has(
        context.controlRunId,
    );
    const controlRun = hasControlRun
        ? rebindControlRunFromSelectionIndex(
            selectionIndex,
            snapshot,
            context.controlRunId,
        )
        : undefined;
    if (hasControlRun && !controlRun) return legacy(true);

    const hasDistributedRun = selectionIndex
        .firstDistributedRunOrdinalByIdAndControlRunId
        .get(context.distributedRunId)?.has(context.controlRunId) === true;
    const distributedRun = hasDistributedRun
        ? rebindDistributedRunPairFromSelectionIndex(
            selectionIndex,
            snapshot,
            context.distributedRunId,
            context.controlRunId,
        )
        : undefined;
    if (hasDistributedRun && !distributedRun) return legacy(true);
    return {
        controlRun,
        distributedRun,
        indexed: true,
        fallback: false,
    };
}

export function publishMonitorReconciliationWork(
    state: MonitorWorkspaceState,
    indexed: boolean,
    fallback: boolean,
): MonitorWorkspaceState {
    workByState.set(state, Object.freeze({ indexed, fallback }));
    return state;
}

export function monitorReconciliationWork(
    state: MonitorWorkspaceState,
): MonitorWorkspaceReconciliationWork | undefined {
    return workByState.get(state);
}
