import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleControlSelection } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import {
    createAnalyzeArtifactModel,
    type AnalyzeArtifactModel,
} from './analyze-artifact-model.ts';
import {
    readAnalyzeArtifactFiles,
    type AnalyzeFileLike,
} from './analyze-file-boundary.ts';
import {
    createAnalyzeImportLabel,
    createAnalyzeInterruptedError,
    validateAnalyzeControlArtifactIdentity,
} from './analyze-workspace-policy.ts';
import {
    analyzeImportedIdentityPatch,
} from './analyze-selection.ts';
import {
    beginAnalyzeWorkspaceOperation,
    clearAnalyzeWorkspaceArtifact,
    completeAnalyzeWorkspaceOperation,
    createAnalyzeWorkspaceContext,
    createInitialAnalyzeWorkspaceState,
    failAnalyzeWorkspaceOperation,
    reconcileAnalyzeWorkspaceContext,
    type AnalyzeWorkspaceAction,
    type AnalyzeWorkspaceContext,
    type AnalyzeWorkspaceOperationAuthority,
} from './analyze-workspace-state.ts';
import { useAnalyzeWorkspaceController } from './use-analyze-workspace-controller.ts';

type PendingOperation = Readonly<{
    controller: AbortController;
    authority: AnalyzeWorkspaceOperationAuthority;
}>;

export function useAnalyzeWorkspace(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    selection: RecipeConsoleControlSelection;
    urlState: RecipeConsoleUrlState;
    navigate(patch: Partial<RecipeConsoleUrlState>): void;
    replace(patch: Partial<RecipeConsoleUrlState>): void;
}>) {
    const [state, setState] = useState(
        createInitialAnalyzeWorkspaceState<AnalyzeArtifactModel>,
    );
    const pendingRef = useRef<PendingOperation | undefined>(undefined);
    const generationRef = useRef(0);
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
        input.selection.distributedRunId,
        input.urlState.controlRunId,
        input.urlState.distributedRunId,
        requestedDistributedRunId,
    ]);
    const controlBoundaryRef = useRef({
        contextKey: context?.key,
        execution: input.connection.execution,
    });
    generationRef.current = Math.max(
        generationRef.current,
        state.operationGeneration,
    );
    controlBoundaryRef.current = {
        contextKey: context?.key,
        execution: input.connection.execution,
    };

    useEffect(() => {
        const pending = pendingRef.current;
        if (pending?.authority.action === 'load-control') {
            pending.controller.abort();
            pendingRef.current = undefined;
        }
        setState(previous => {
            if (previous.contextKey !== context?.key) {
                return reconcileAnalyzeWorkspaceContext(previous, context);
            }
            if (previous.activeOperation?.action === 'load-control') {
                return failAnalyzeWorkspaceOperation(
                    previous,
                    previous.activeOperation,
                    createAnalyzeInterruptedError('Analyze control source changed.'),
                );
            }
            return previous;
        });
    }, [context, input.connection.execution]);
    useEffect(() => () => {
        pendingRef.current?.controller.abort();
        pendingRef.current = undefined;
    }, []);

    const perform = useCallback(async (
        action: AnalyzeWorkspaceAction,
        operationContext: AnalyzeWorkspaceContext | undefined,
        operation: (signal: AbortSignal) => Promise<AnalyzeArtifactModel>,
    ): Promise<AnalyzeArtifactModel | undefined> => {
        if (pendingRef.current) return undefined;
        const contextKey = action === 'load-control'
            ? operationContext?.key
            : 'local-import';
        if (!contextKey) return undefined;
        const controller = new AbortController();
        const generation = ++generationRef.current;
        const authority: AnalyzeWorkspaceOperationAuthority = {
            action,
            contextKey,
            generation,
            ...(action === 'load-control'
                ? {
                    expectedControlRunId: operationContext?.controlRunId,
                    expectedDistributedRunId: operationContext?.distributedRunId,
                }
                : {}),
        };
        pendingRef.current = { controller, authority };
        setState(previous => beginAnalyzeWorkspaceOperation(
            action === 'load-control'
                ? reconcileAnalyzeWorkspaceContext(previous, operationContext)
                : previous,
            {
                action,
                contextKey,
                expectedControlRunId: authority.expectedControlRunId,
                expectedDistributedRunId: authority.expectedDistributedRunId,
            },
            generation,
        ).state);
        try {
            const model = await operation(controller.signal);
            if (controller.signal.aborted || pendingRef.current?.authority !== authority) {
                return undefined;
            }
            if (action === 'load-control' && operationContext) {
                validateAnalyzeControlArtifactIdentity(model, operationContext);
            }
            setState(previous => completeAnalyzeWorkspaceOperation(
                previous,
                authority,
                {
                    artifact: model,
                    selectedEvidenceId: model.firstActionableEvidenceId,
                },
            ));
            return model;
        } catch (error) {
            if (!controller.signal.aborted) {
                setState(previous => failAnalyzeWorkspaceOperation(
                    previous,
                    authority,
                    error,
                ));
            }
            return undefined;
        } finally {
            if (pendingRef.current?.authority === authority) {
                pendingRef.current = undefined;
            }
        }
    }, []);

    const importFiles = useCallback(async (
        files: readonly AnalyzeFileLike[],
    ): Promise<boolean> => {
        if (files.length === 0) return false;
        const generatedAtEpochMs = Date.now();
        const model = await perform('import-local', undefined, async signal => {
            const intake = await readAnalyzeArtifactFiles(files);
            if (signal.aborted) {
                throw createAnalyzeInterruptedError(
                    'Artifact import was interrupted.',
                );
            }
            return createAnalyzeArtifactModel({
                files: intake.files,
                source: 'local-files',
                label: createAnalyzeImportLabel(
                    intake.acceptedFiles.map(file => file.basename),
                ),
                generatedAtEpochMs,
                ignoredFiles: intake.ignoredFiles,
            });
        });
        if (model) input.navigate(analyzeImportedIdentityPatch(model.identity));
        return model !== undefined;
    }, [input.navigate, perform]);

    const loadControlArtifact = useCallback(async (): Promise<boolean> => {
        const execution = input.connection.execution;
        if (!execution || !context) return false;
        const model = await perform('load-control', context, async signal => {
            const bundle = await execution.exportRunArtifact({
                distributedRunId: context.distributedRunId,
                signal,
            });
            if (
                signal.aborted ||
                controlBoundaryRef.current.contextKey !== context.key ||
                controlBoundaryRef.current.execution !== execution
            ) {
                throw createAnalyzeInterruptedError(
                    'Analyze control source changed while the artifact was loading.',
                );
            }
            if (bundle.distributedRunId !== context.distributedRunId) {
                throw new Error(
                    `Artifact response belongs to ${bundle.distributedRunId}, not ${context.distributedRunId}.`,
                );
            }
            return createAnalyzeArtifactModel({
                files: bundle.files,
                source: 'control',
                label: `Control artifact ${bundle.distributedRunId}`,
                generatedAtEpochMs: bundle.generatedAtEpochMs,
                artifactSchemaVersion: bundle.artifactSchemaVersion,
            });
        });
        if (model) input.navigate(analyzeImportedIdentityPatch(model.identity));
        return model !== undefined;
    }, [context, input.connection.execution, input.navigate, perform]);

    return useAnalyzeWorkspaceController({
        ...input,
        context,
        requestedDistributedRunId,
        state,
        setState,
        importFiles,
        loadControlArtifact,
        clearArtifact: () => {
            pendingRef.current?.controller.abort();
            pendingRef.current = undefined;
            setState(clearAnalyzeWorkspaceArtifact);
        },
    });
}

export type AnalyzeWorkspaceController = ReturnType<typeof useAnalyzeWorkspace>;
