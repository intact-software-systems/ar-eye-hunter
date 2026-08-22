import type { ControlSnapshotSelectionIndex } from '@shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlQuerySnapshot, ControlQueryStatus } from '../control/control-query.ts';
import { createInitialMonitorOperationState, type MonitorOperationState } from './monitor-operation-state.ts';
import type { MonitorEvidenceSelection } from './monitor-selection.ts';
import {
    monitorReconciliationWork,
    publishMonitorReconciliationWork,
    resolveMonitorContextRuns,
    type MonitorWorkspaceReconciliationWork
} from './monitor-workspace-index-reconciliation.ts';
import { compatibleMonitorMutation, preferMonitorMutationTruth } from './monitor-workspace-mutation-truth.ts';

export {
    beginMonitorOperation,
    completeMonitorArtifactOperation,
    completeMonitorOperation,
    failMonitorOperation,
    hasMonitorOperationAuthority
} from './monitor-operation-state.ts';
export type {
    MonitorArtifactState,
    MonitorOperationAuthority
} from './monitor-operation-state.ts';

export type MonitorWorkspaceContext = Readonly<{
    key: string;
    baseUrl: string;
    controlRunId: string;
    distributedRunId: string;
}>;

export type MonitorWorkspaceSource = Readonly<{
    contextKey: string;
    controlRun: ControlRunSnapshot;
    distributedRun: ControlDistributedRunSnapshot;
    freshness: 'current' | 'last-known';
    completeness: 'complete' | 'partial';
    queryStatus: ControlQueryStatus;
    origin: 'query' | 'mutation';
    receivedAtEpochMs?: number;
}>;

export type MonitorWorkspaceState =
    & Readonly<{
        source?: MonitorWorkspaceSource;
        mutationRun?: ControlDistributedRunSnapshot;
        evidenceSelection?: MonitorEvidenceSelection;
        cancelArmKey?: string;
    }>
    & MonitorOperationState;

export type { MonitorWorkspaceReconciliationWork } from './monitor-workspace-index-reconciliation.ts';

export function createMonitorWorkspaceContext(
    input: Readonly<{
        baseUrl: string;
        controlRunId: string;
        distributedRunId: string;
    }>
): MonitorWorkspaceContext {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    const identity = {
        baseUrl,
        controlRunId: input.controlRunId,
        distributedRunId: input.distributedRunId
    };
    return { key: JSON.stringify(identity), ...identity };
}

export function createInitialMonitorWorkspaceState(): MonitorWorkspaceState {
    return {
        ...createInitialMonitorOperationState(),
        source: undefined,
        mutationRun: undefined,
        evidenceSelection: undefined,
        cancelArmKey: undefined
    };
}

export function reconcileMonitorWorkspaceState(
    previous: MonitorWorkspaceState,
    input: Readonly<{
        context?: MonitorWorkspaceContext;
        query: ControlQuerySnapshot<ControlServerSnapshot>;
        selectionIndex?: ControlSnapshotSelectionIndex;
    }>
): MonitorWorkspaceState {
    const state = previous.contextKey === input.context?.key
        ? previous
        : resetForContext(previous, input.context?.key);
    if (!input.context) {
        return publishMonitorReconciliationWork(state, false, false);
    }

    const { query } = input;
    if (query.status === 'live' || query.status === 'partial') {
        return reconcileCurrentQuery(
            state,
            input.context,
            query,
            input.selectionIndex
        );
    }
    if (!state.source) {
        return publishMonitorReconciliationWork(state, false, false);
    }
    return publishMonitorReconciliationWork(
        {
            ...state,
            source: {
                ...state.source,
                freshness: 'last-known',
                queryStatus: query.status
            }
        },
        false,
        false
    );
}

export function monitorWorkspaceReconciliationWorkForTest(
    state: MonitorWorkspaceState
): MonitorWorkspaceReconciliationWork | undefined {
    return monitorReconciliationWork(state);
}

export function projectMonitorMutation(
    state: MonitorWorkspaceState,
    contextKey: string,
    run: ControlDistributedRunSnapshot
): MonitorWorkspaceState {
    if (!isMatchingContextRun(state, contextKey, run)) {
        return {
            ...state,
            operationError: new Error(
                'Control response identity does not match the current Monitor run.'
            )
        };
    }
    if (
        preferMonitorMutationTruth(
            run,
            state.source.distributedRun
        ) !== run
    ) {
        return state;
    }
    return {
        ...state,
        mutationRun: run,
        source: {
            ...state.source,
            distributedRun: run,
            origin: 'mutation'
        },
        operationError: undefined
    };
}

export function setMonitorEvidenceSelection(
    state: MonitorWorkspaceState,
    contextKey: string,
    selection: MonitorEvidenceSelection | undefined
): MonitorWorkspaceState {
    return state.contextKey === contextKey
        ? { ...state, evidenceSelection: selection }
        : state;
}

export function setMonitorCancelArm(
    state: MonitorWorkspaceState,
    contextKey: string,
    cancelArmKey: string | undefined
): MonitorWorkspaceState {
    return state.contextKey === contextKey
        ? { ...state, cancelArmKey }
        : state;
}

function reconcileCurrentQuery(
    state: MonitorWorkspaceState,
    context: MonitorWorkspaceContext,
    query: ControlQuerySnapshot<ControlServerSnapshot>,
    selectionIndex: ControlSnapshotSelectionIndex | undefined
): MonitorWorkspaceState {
    const snapshot = query.snapshot;
    const resolved = resolveMonitorContextRuns(
        snapshot,
        context,
        selectionIndex
    );
    const { controlRun, distributedRun } = resolved;
    if (controlRun && distributedRun) {
        const mutation = compatibleMonitorMutation(state.mutationRun, context);
        const selectedRun = mutation
            ? preferMonitorMutationTruth(mutation, distributedRun)
            : distributedRun;
        const keepMutation = selectedRun === mutation;
        return publishMonitorReconciliationWork(
            {
                ...state,
                mutationRun: keepMutation ? mutation : undefined,
                source: {
                    contextKey: context.key,
                    controlRun,
                    distributedRun: selectedRun,
                    freshness: 'current',
                    completeness: query.status === 'live' ? 'complete' : 'partial',
                    queryStatus: query.status,
                    origin: keepMutation ? 'mutation' : 'query',
                    receivedAtEpochMs: query.receivedAtEpochMs
                }
            },
            resolved.indexed,
            resolved.fallback
        );
    }
    if (
        query.status === 'partial' &&
        query.snapshot?.distributedRuns === undefined &&
        controlRun &&
        state.source
    ) {
        return publishMonitorReconciliationWork(
            {
                ...state,
                source: {
                    ...state.source,
                    freshness: 'last-known',
                    completeness: 'partial',
                    queryStatus: 'partial'
                }
            },
            resolved.indexed,
            resolved.fallback
        );
    }
    return publishMonitorReconciliationWork(
        { ...state, source: undefined, mutationRun: undefined },
        resolved.indexed,
        resolved.fallback
    );
}

function resetForContext(
    state: MonitorWorkspaceState,
    contextKey: string | undefined
): MonitorWorkspaceState {
    return {
        ...createInitialMonitorWorkspaceState(),
        contextKey,
        operationGeneration: state.operationGeneration + 1
    };
}

function isMatchingContextRun(
    state: MonitorWorkspaceState,
    contextKey: string,
    run: ControlDistributedRunSnapshot
): state is MonitorWorkspaceState & Readonly<{ source: MonitorWorkspaceSource; }> {
    return state.contextKey === contextKey &&
        state.source !== undefined &&
        run.distributedRunId === state.source.distributedRun.distributedRunId &&
        run.controlRunId === state.source.controlRun.runId;
}
