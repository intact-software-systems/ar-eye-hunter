import { useEffect, useMemo } from 'react';
import type { DistributedArtifactEvidenceWindowQuery } from
    '@shared-test/rallar-bb-test/mod.ts';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from
    '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import { createAnalyzeWorkspaceContext } from './analyze-workspace-state.ts';
import { useAnalyzeOperations } from './use-analyze-operations.ts';
import { useAnalyzeWorkspaceController } from
    './use-analyze-workspace-controller.ts';
import { analyzeEvidenceQueryFingerprint } from
    './analyze-evidence-query-fingerprint.ts';

export function useAnalyzeWorkspace(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const requestedDistributedRunId = input.urlState.distributedRunId ??
        input.selection.distributedRunId;
    const context = useMemo(() => requestedDistributedRunId
        ? createAnalyzeWorkspaceContext({
            baseUrl: input.connection.baseUrl,
            controlRunId: input.urlState.controlRunId ??
                input.selection.controlRunId,
            distributedRunId: requestedDistributedRunId,
        })
        : undefined, [
        input.connection.baseUrl,
        input.selection.controlRunId,
        input.urlState.controlRunId,
        requestedDistributedRunId,
    ]);
    const operations = useAnalyzeOperations({
        connection: input.connection,
        context,
        navigate: input.navigate,
    });
    const query = useMemo((): DistributedArtifactEvidenceWindowQuery => ({
        query: input.urlState.historyQuery,
        agentId: input.urlState.agentId,
        recipeId: input.urlState.recipeId,
        commandId: input.urlState.commandId,
        status: input.urlState.status,
        severity: input.urlState.diagnosticSeverity,
        transport: input.urlState.transport,
        fromEpochMs: input.urlState.from,
        toEpochMs: input.urlState.to,
    }), [
        input.urlState.agentId,
        input.urlState.commandId,
        input.urlState.diagnosticSeverity,
        input.urlState.from,
        input.urlState.historyQuery,
        input.urlState.recipeId,
        input.urlState.status,
        input.urlState.to,
        input.urlState.transport,
    ]);
    const queryFingerprint = useMemo(() => analyzeEvidenceQueryFingerprint(
        operations.state.operationGeneration,
        query,
    ), [operations.state.operationGeneration, query]);

    useEffect(() => {
        if (input.urlState.view !== 'analyze' || !operations.state.artifact) {
            return;
        }
        operations.search(query, queryFingerprint);
    }, [
        input.urlState.view,
        operations.search,
        operations.state.artifact,
        query,
        queryFingerprint,
    ]);

    useEffect(() => {
        if (input.urlState.view !== 'tune' || !operations.state.artifact) return;
        operations.requestTune({
            focusRunId: input.urlState.compareRight ??
                input.urlState.distributedRunId,
            compareLeft: input.urlState.compareLeft,
            compareRight: input.urlState.compareRight,
            timingMetric: input.urlState.timingMetric,
        });
    }, [
        input.urlState.compareLeft,
        input.urlState.compareRight,
        input.urlState.distributedRunId,
        input.urlState.timingMetric,
        input.urlState.view,
        operations.requestTune,
        operations.state.artifact,
    ]);

    return useAnalyzeWorkspaceController({
        ...input,
        context,
        requestedDistributedRunId,
        state: operations.state,
        evidenceWindow: operations.evidenceWindow,
        evidenceWindowFingerprint: operations.evidenceWindowFingerprint,
        evidenceWindowPending: operations.evidenceWindowPending,
        evidenceWindowError: operations.evidenceWindowError,
        queryFingerprint,
        selectedEvidence: operations.selectedEvidence,
        tuneFacade: operations.tuneFacade,
        telemetry: operations.telemetry,
        workerUnavailable: operations.workerUnavailable,
        pendingPaintGeneration: operations.pendingPaintGeneration,
        importFiles: operations.importFiles,
        loadControlArtifact: operations.loadControlArtifact,
        exportArtifact: operations.exportArtifact,
        requestWindow: cursor => operations.requestWindow(
            query,
            cursor,
            queryFingerprint,
        ),
        retryEvidenceSearch: () => operations.search(query, queryFingerprint),
        selectEvidence: operations.selectEvidence,
        clearArtifact: operations.clearArtifact,
    });
}

export type AnalyzeWorkspaceController = ReturnType<typeof useAnalyzeWorkspace>;
