import { useMemo } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type {
    AnalyzeFileLike,
    AnalyzeTransferFileLike,
} from './analyze-file-boundary.ts';
import type {
    AnalyzeArtifactProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerTelemetry,
} from './analyze-worker-contract.ts';
import {
    deriveAnalyzeControlRunOptions,
    deriveAnalyzeDistributedRunOptions,
    findAnalyzeDistributedRunOption,
    analyzeFilterClearPatch,
    recipeConsoleAnalyzeControlRunSelectionPatch,
    recipeConsoleAnalyzeDistributedRunSelectionPatch,
} from './analyze-selection.ts';
import {
    projectAnalyzeWorkspaceError,
    projectAnalyzeWorkspaceLoadReason,
} from './analyze-workspace-policy.ts';
import {
    type AnalyzeWorkspaceContext,
    type AnalyzeWorkspaceState,
} from './analyze-workspace-state.ts';

export function useAnalyzeWorkspaceController(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    context?: AnalyzeWorkspaceContext;
    requestedDistributedRunId?: string;
    state: AnalyzeWorkspaceState<AnalyzeArtifactProjection>;
    evidenceWindow?: AnalyzeEvidenceWindowProjection;
    selectedEvidence?: AnalyzeEvidenceWindowProjection['entries'][number];
    tuneFacade?: AnalyzeTuneArtifactFacade;
    telemetry?: AnalyzeWorkerTelemetry;
    workerUnavailable?: string;
    pendingPaintGeneration?: number;
    importFiles(files: readonly (AnalyzeFileLike & Partial<AnalyzeTransferFileLike>)[]): Promise<boolean>;
    loadControlArtifact(): Promise<boolean>;
    exportArtifact(): void;
    requestWindow(cursor: string): number | undefined;
    selectEvidence(id: string | undefined): void;
    clearArtifact(): void;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const model = input.state.artifact;
    const searchResult = useMemo(() => input.evidenceWindow
        ? {
            entries: input.evidenceWindow.entries,
            totalMatches: input.evidenceWindow.counts.retainedMatches,
            omittedMatchCount: input.evidenceWindow.counts.renderOmittedMatches,
            upstreamOmittedEntryCount:
                input.evidenceWindow.counts.indexOmittedEntries,
            totalMatchesIsComplete: input.evidenceWindow.totalMatchesIsComplete,
            limit: input.evidenceWindow.windowSize,
        }
        : undefined, [input.evidenceWindow]);
    const controlRunOptions = useMemo(
        () => deriveAnalyzeControlRunOptions(
            input.connection.query.snapshot?.runs ?? [],
        ),
        [input.connection.query.snapshot?.runs],
    );
    const distributedRunOptions = useMemo(
        () => deriveAnalyzeDistributedRunOptions({
            controlRunId: input.selection.controlRunId,
            distributedRuns:
                input.connection.query.snapshot?.distributedRuns ?? [],
        }),
        [
            input.connection.query.snapshot?.distributedRuns,
            input.selection.controlRunId,
        ],
    );

    return {
        model,
        searchResult,
        selectedEvidence: input.selectedEvidence,
        evidenceWindow: input.evidenceWindow,
        tuneFacade: input.tuneFacade,
        telemetry: input.telemetry,
        operationGeneration: input.state.operationGeneration,
        pendingPaintGeneration: input.pendingPaintGeneration,
        controlRunOptions,
        distributedRunOptions,
        controlRunId: input.selection.controlRunId,
        distributedRunId: input.requestedDistributedRunId,
        status: input.state.artifactStatus,
        error: projectAnalyzeWorkspaceError(input.state.operationError) ??
            input.workerUnavailable,
        busyAction: input.state.activeOperation?.action,
        canLoad: Boolean(
            input.context && input.connection.execution &&
            !input.state.activeOperation
        ),
        loadReason: projectAnalyzeWorkspaceLoadReason(
            input.context,
            input.connection.execution,
            input.state.activeOperation?.action,
        ),
        importFiles: input.importFiles,
        loadControlArtifact: input.loadControlArtifact,
        exportArtifact: input.exportArtifact,
        clearArtifact: input.clearArtifact,
        selectEvidence: input.selectEvidence,
        requestWindow: input.requestWindow,
        selectControlRun: (controlRunId: string) => input.navigate(
            controlRunId
                ? recipeConsoleAnalyzeControlRunSelectionPatch({
                    state: input.urlState,
                    controlRunId,
                    distributedRuns:
                        input.connection.query.snapshot?.distributedRuns ?? [],
                })
                : {
                    controlRunId: undefined,
                    distributedRunId: undefined,
                    agentId: undefined,
                    recipeId: undefined,
                    commandId: undefined,
                },
        ),
        selectDistributedRun: (distributedRunId: string) => {
            const run = findAnalyzeDistributedRunOption(
                distributedRunOptions,
                distributedRunId,
            );
            if (run) {
                input.navigate(
                    recipeConsoleAnalyzeDistributedRunSelectionPatch(run),
                );
            } else if (!distributedRunId) {
                input.navigate({
                    distributedRunId: undefined,
                    agentId: undefined,
                    recipeId: undefined,
                    commandId: undefined,
                });
            }
        },
        updateFilters: (
            patch: Partial<RecipeConsoleUrlState>,
            replace = false,
        ) => (replace ? input.replace : input.navigate)(patch),
        clearFilters: () => input.navigate(analyzeFilterClearPatch()),
    } as const;
}
