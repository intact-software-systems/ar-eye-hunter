import { useMemo } from 'react';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { AnalyzeFileLike, AnalyzeTransferFileLike } from './analyze-file-boundary.ts';
import {
    analyzeFilterClearPatch,
    deriveAnalyzeControlRunOptions,
    deriveAnalyzeDistributedRunOptions,
    findAnalyzeDistributedRunOption,
    recipeConsoleAnalyzeControlRunSelectionPatch,
    recipeConsoleAnalyzeDistributedRunSelectionPatch
} from './analyze-selection.ts';
import type {
    AnalyzeArtifactProjection,
    AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerTelemetry
} from './analyze-worker-contract.ts';
import { projectAnalyzeWorkspaceError, projectAnalyzeWorkspaceLoadReason } from './analyze-workspace-policy.ts';
import { type AnalyzeWorkspaceContext, type AnalyzeWorkspaceState } from './analyze-workspace-state.ts';

export function useAnalyzeWorkspaceController(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        selection: RecipeConsoleControlSelection;
        urlState: RecipeConsoleUrlState;
        context?: AnalyzeWorkspaceContext;
        requestedDistributedRunId?: string;
        state: AnalyzeWorkspaceState<AnalyzeArtifactProjection>;
        evidenceWindow?: AnalyzeEvidenceWindowProjection;
        evidenceWindowFingerprint?: string;
        evidenceWindowPending: boolean;
        evidenceWindowError?: string;
        queryFingerprint: string;
        selectedEvidence?: AnalyzeEvidenceWindowProjection['entries'][number];
        tuneFacade?: AnalyzeTuneArtifactFacade;
        telemetry?: AnalyzeWorkerTelemetry;
        workerUnavailable?: string;
        pendingPaintGeneration?: number;
        importFiles(files: readonly (AnalyzeFileLike & Partial<AnalyzeTransferFileLike>)[]): Promise<boolean>;
        loadControlArtifact(): Promise<boolean>;
        exportArtifact(): void;
        requestWindow(cursor: string): number | undefined;
        retryEvidenceSearch(): number | undefined;
        selectEvidence(id: string | undefined): void;
        clearArtifact(): void;
        navigate(patch: Partial<RecipeConsoleUrlState>): void;
        replace(patch: Partial<RecipeConsoleUrlState>): void;
    }>
) {
    const active = input.urlState.view === 'analyze';
    const model = input.state.artifact;
    const searchResult = useMemo(() =>
        (
                input.evidenceWindow &&
                input.evidenceWindowFingerprint === input.queryFingerprint
            )
            ? {
                entries: input.evidenceWindow.entries,
                totalMatches: input.evidenceWindow.counts.retainedMatches,
                omittedMatchCount: input.evidenceWindow.counts.renderOmittedMatches,
                upstreamOmittedEntryCount: input.evidenceWindow.counts.indexOmittedEntries,
                totalMatchesIsComplete: input.evidenceWindow.totalMatchesIsComplete,
                limit: input.evidenceWindow.windowSize
            }
            : undefined, [
        input.evidenceWindow,
        input.evidenceWindowFingerprint,
        input.queryFingerprint
    ]);
    const controlRunOptions = useMemo(
        () =>
            deriveAnalyzeControlRunOptions(
                input.connection.query.snapshot?.runs ?? [],
                active
            ),
        [active, input.connection.query.snapshot?.runs]
    );
    const distributedRunOptions = useMemo(
        () =>
            deriveAnalyzeDistributedRunOptions({
                controlRunId: input.selection.controlRunId,
                distributedRuns: input.connection.query.snapshot?.distributedRuns ?? []
            }, active),
        [
            active,
            input.connection.query.snapshot?.distributedRuns,
            input.selection.controlRunId
        ]
    );

    return {
        model,
        searchResult,
        selectedEvidence: input.selectedEvidence,
        evidenceWindow: input.evidenceWindow,
        evidenceWindowFingerprint: input.evidenceWindowFingerprint,
        evidenceWindowPending: input.evidenceWindowPending,
        evidenceWindowError: input.evidenceWindowError,
        queryFingerprint: input.queryFingerprint,
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
            input.state.activeOperation?.action
        ),
        importFiles: input.importFiles,
        loadControlArtifact: input.loadControlArtifact,
        exportArtifact: input.exportArtifact,
        clearArtifact: input.clearArtifact,
        selectEvidence: input.selectEvidence,
        requestWindow: input.requestWindow,
        retryEvidenceSearch: input.retryEvidenceSearch,
        selectControlRun: (controlRunId: string) =>
            input.navigate(
                controlRunId
                    ? recipeConsoleAnalyzeControlRunSelectionPatch({
                        state: input.urlState,
                        controlRunId,
                        distributedRuns: input.connection.query.snapshot?.distributedRuns ?? []
                    })
                    : {
                        controlRunId: undefined,
                        distributedRunId: undefined,
                        agentId: undefined,
                        recipeId: undefined,
                        commandId: undefined
                    }
            ),
        selectDistributedRun: (distributedRunId: string) => {
            const run = findAnalyzeDistributedRunOption(
                distributedRunOptions,
                distributedRunId
            );
            if (run) {
                input.navigate(
                    recipeConsoleAnalyzeDistributedRunSelectionPatch(run)
                );
            }
            else if (!distributedRunId) {
                input.navigate({
                    distributedRunId: undefined,
                    agentId: undefined,
                    recipeId: undefined,
                    commandId: undefined
                });
            }
        },
        updateFilters: (
            patch: Partial<RecipeConsoleUrlState>,
            replace = false
        ) => (replace ? input.replace : input.navigate)(patch),
        clearFilters: () => input.navigate(analyzeFilterClearPatch())
    } as const;
}
