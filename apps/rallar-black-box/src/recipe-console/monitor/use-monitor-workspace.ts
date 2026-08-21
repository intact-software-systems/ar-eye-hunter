import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    createMonitorCancelArmContext,
    deriveMonitorActionPolicy,
    monitorConnectionTruth
} from './monitor-action-policy.ts';
import {
    deriveMonitorDistributedRunSelection,
    deriveMonitorRunOptions,
    deriveMonitorUrlEvidenceSelection,
    monitorUrlEvidenceKey,
    recipeConsoleMonitorDistributedRunSelectionPatch,
    type MonitorEvidenceSelection
} from './monitor-selection.ts';
import { deriveMonitorWorkspaceModel } from './monitor-workspace-model.ts';
import {
    createInitialMonitorWorkspaceState,
    createMonitorWorkspaceContext,
    reconcileMonitorWorkspaceState,
    setMonitorCancelArm,
    setMonitorEvidenceSelection
} from './monitor-workspace-state.ts';
import { useMonitorOperations } from './use-monitor-operations.ts';

export function useMonitorWorkspace(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        selection: RecipeConsoleControlSelection;
        urlState: RecipeConsoleUrlState;
        navigate(patch: Partial<RecipeConsoleUrlState>): void;
        replace(patch: Partial<RecipeConsoleUrlState>): void;
    }>
) {
    const [state, setState] = useState(createInitialMonitorWorkspaceState);
    const authoredEvidenceKeyRef = useRef<string | undefined>(undefined);
    const urlEvidenceKey = monitorUrlEvidenceKey(input.urlState);
    const distributedRuns = input.connection.query.snapshot?.distributedRuns ?? [];
    const distributedRunsAuthoritative = (
        input.connection.query.status === 'live' ||
        input.connection.query.status === 'partial'
    ) && input.connection.query.snapshot?.distributedRuns !== undefined;
    const distributedSelection = useMemo(
        () =>
            deriveMonitorDistributedRunSelection({
                controlRunId: input.selection.controlRunId,
                requestedDistributedRunId: input.urlState.distributedRunId,
                distributedRuns,
                distributedRunsAuthoritative,
                snapshot: input.connection.query.snapshot,
                selectionIndex: input.connection.selectionIndex
            }),
        [
            distributedRunsAuthoritative,
            input.connection.query.snapshot,
            input.connection.selectionIndex,
            input.selection.controlRunId,
            input.urlState.distributedRunId
        ]
    );
    const context = useMemo(() => {
        const controlRunId = input.selection.controlRunId;
        const distributedRunId = distributedSelection.distributedRunId;
        return controlRunId && distributedRunId
            ? createMonitorWorkspaceContext({
                baseUrl: input.connection.baseUrl,
                controlRunId,
                distributedRunId
            })
            : undefined;
    }, [
        distributedSelection.distributedRunId,
        input.connection.baseUrl,
        input.selection.controlRunId
    ]);

    useEffect(() => {
        if (distributedSelection.urlReplacePatch) {
            input.replace(distributedSelection.urlReplacePatch);
        }
    }, [distributedSelection.urlReplacePatch, input.replace]);
    useEffect(() => {
        setState((previous) =>
            reconcileMonitorWorkspaceState(previous, {
                context,
                query: input.connection.query,
                selectionIndex: input.connection.selectionIndex
            })
        );
    }, [
        context?.key,
        input.connection.query.receivedAtEpochMs,
        input.connection.query.snapshot,
        input.connection.query.status,
        input.connection.selectionIndex
    ]);
    useEffect(() => {
        if (!context) {
            return;
        }
        if (authoredEvidenceKeyRef.current === urlEvidenceKey) {
            authoredEvidenceKeyRef.current = undefined;
            return;
        }
        setState((previous) =>
            setMonitorEvidenceSelection(
                previous,
                context.key,
                deriveMonitorUrlEvidenceSelection(input.urlState)
            )
        );
    }, [context?.key, urlEvidenceKey]);

    const currentState = state.contextKey === context?.key
        ? state
        : createInitialMonitorWorkspaceState();
    const model = useMemo(
        () => deriveMonitorWorkspaceModel(currentState),
        [currentState]
    );
    const connectionTruth = monitorConnectionTruth(input.connection.query);
    const armContext = model?.source.distributedRun
        ? createMonitorCancelArmContext({
            baseUrl: input.connection.baseUrl,
            controlRunId: model.source.controlRun.runId,
            distributedRunId: model.source.distributedRun.distributedRunId,
            runState: model.source.distributedRun.state,
            updatedAtEpochMs: model.source.distributedRun.updatedAtEpochMs
        })
        : undefined;
    const policy = deriveMonitorActionPolicy({
        connection: connectionTruth,
        evidence: model?.source.freshness ?? 'none',
        runState: model?.source.distributedRun.state,
        cancelArmKey: armContext?.key,
        armedKey: currentState.cancelArmKey,
        busyAction: currentState.activeOperation?.action
    });
    const operations = useMonitorOperations({
        connection: input.connection,
        context,
        policy,
        run: model?.source.distributedRun,
        state: currentState,
        setState
    });
    const runOptions = useMemo(() => {
        return deriveMonitorRunOptions({
            controlRunId: input.selection.controlRunId,
            distributedRuns,
            lastKnown: model?.source.distributedRun,
            snapshot: input.connection.query.snapshot,
            selectionIndex: input.connection.selectionIndex
        });
    }, [
        distributedRuns,
        input.connection.query.snapshot,
        input.connection.selectionIndex,
        input.selection.controlRunId,
        model?.source.distributedRun
    ]);

    const selectEvidence = useCallback((
        selection: MonitorEvidenceSelection | undefined,
        patch: Partial<RecipeConsoleUrlState> = {}
    ) => {
        if (!context) {
            return;
        }
        setState((previous) =>
            setMonitorEvidenceSelection(
                previous,
                context.key,
                selection
            )
        );
        if (Object.keys(patch).length > 0) {
            const nextEvidenceKey = monitorUrlEvidenceKey({
                ...input.urlState,
                ...patch
            });
            if (nextEvidenceKey === urlEvidenceKey) {
                return;
            }
            authoredEvidenceKeyRef.current = nextEvidenceKey;
            input.navigate(patch);
        }
    }, [context, input.navigate, input.urlState, urlEvidenceKey]);
    const toggleCancelArm = useCallback(() => {
        if (!context || !armContext) {
            return;
        }
        setState((previous) =>
            setMonitorCancelArm(
                previous,
                context.key,
                previous.cancelArmKey === armContext.key
                    ? undefined
                    : armContext.key
            )
        );
    }, [armContext, context]);
    const selectDistributedRun = useCallback((distributedRunId: string) => {
        input.navigate(
            recipeConsoleMonitorDistributedRunSelectionPatch(distributedRunId)
        );
    }, [input.navigate]);

    return {
        state: currentState,
        model,
        context,
        connectionTruth,
        distributedSelection,
        runOptions,
        policy,
        armContext,
        selectDistributedRun,
        selectEvidence,
        toggleCancelArm,
        operations
    } as const;
}
