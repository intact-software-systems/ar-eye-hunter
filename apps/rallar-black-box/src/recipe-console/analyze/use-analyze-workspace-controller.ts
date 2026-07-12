import {
    useMemo,
    type Dispatch,
    type SetStateAction,
} from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import { downloadDistributedRunArtifact } from '../control/distributed-run-artifact-download.ts';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    deriveAnalyzeArtifactSearchResult,
    type AnalyzeArtifactModel,
} from './analyze-artifact-model.ts';
import type { AnalyzeFileLike } from './analyze-file-boundary.ts';
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
    selectAnalyzeWorkspaceEvidence,
    type AnalyzeWorkspaceContext,
    type AnalyzeWorkspaceState,
} from './analyze-workspace-state.ts';

export function useAnalyzeWorkspaceController(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    context?: AnalyzeWorkspaceContext;
    requestedDistributedRunId?: string;
    state: AnalyzeWorkspaceState<AnalyzeArtifactModel>;
    setState: Dispatch<SetStateAction<AnalyzeWorkspaceState<AnalyzeArtifactModel>>>;
    importFiles(files: readonly AnalyzeFileLike[]): Promise<boolean>;
    loadControlArtifact(): Promise<boolean>;
    clearArtifact(): void;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const model = input.state.artifact;
    const searchResult = useMemo(
        () => model
            ? deriveAnalyzeArtifactSearchResult(model, input.urlState)
            : undefined,
        [input.urlState, model],
    );
    const selectedEvidence = model?.evidenceIndex.entries.find(
        entry => entry.id === input.state.selectedEvidenceId,
    );
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
        selectedEvidence,
        controlRunOptions,
        distributedRunOptions,
        controlRunId: input.selection.controlRunId,
        distributedRunId: input.requestedDistributedRunId,
        status: input.state.artifactStatus,
        error: projectAnalyzeWorkspaceError(input.state.operationError),
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
        exportArtifact: () => {
            if (model) {
                downloadDistributedRunArtifact(
                    model.portableEnvelope,
                    model.distributedRunId,
                );
            }
        },
        clearArtifact: input.clearArtifact,
        selectEvidence: (id: string | undefined) => input.setState(
            previous => selectAnalyzeWorkspaceEvidence(previous, id),
        ),
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
