import type { DistributedArtifactEvidenceWindowQuery } from '@shared-test/rallar-bb-test/mod.ts';
import { useCallback, useEffect, useRef } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import { createAnalyzeControlIdentityDigest } from './analyze-control-identity-digest.ts';
import { resolveAnalyzeOperationContext } from './analyze-current-url-boundary.ts';
import { createAnalyzeLocalOffer, type AnalyzeImportFile } from './analyze-local-offer.ts';
import { boundedText, MAX_METADATA_BYTES } from './analyze-projection-bounds.ts';
import { analyzeImportedIdentityPatch } from './analyze-selection.ts';
import type { AnalyzeWorkerClient } from './analyze-worker-client.ts';
import type { AnalyzeWorkerArtifactOffer } from './analyze-worker-contract.ts';
import {
    useAnalyzeWorkerWorkspaceAdapter,
    type AnalyzeControlBoundary,
    type AnalyzePendingOperation
} from './analyze-worker-workspace-adapter.ts';
import { createAnalyzeInterruptedError } from './analyze-workspace-policy.ts';
import {
    beginAnalyzeWorkspaceOperation,
    failAnalyzeWorkspaceOperation,
    reconcileAnalyzeWorkspaceContext,
    type AnalyzeWorkspaceAction,
    type AnalyzeWorkspaceContext,
    type AnalyzeWorkspaceOperationAuthority
} from './analyze-workspace-state.ts';

export function useAnalyzeOperations(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        context?: AnalyzeWorkspaceContext;
        navigate(patch: ReturnType<typeof analyzeImportedIdentityPatch>): void;
    }>
) {
    const inputRef = useRef(input);
    inputRef.current = input;
    const currentOperationContext = () =>
        resolveAnalyzeOperationContext({
            baseUrl: inputRef.current.connection.baseUrl,
            renderedContext: inputRef.current.context,
            search: typeof window === 'undefined' ? undefined : window.location.search
        });
    const pendingRef = useRef<AnalyzePendingOperation | undefined>(undefined);
    const generationRef = useRef(0);
    const boundaryRef = useRef<AnalyzeControlBoundary>({
        contextKey: input.context?.key,
        currentContextKey: () => currentOperationContext()?.key,
        execution: input.connection.execution,
        baseUrl: input.connection.baseUrl
    });
    boundaryRef.current = {
        contextKey: input.context?.key,
        currentContextKey: () => currentOperationContext()?.key,
        execution: input.connection.execution,
        baseUrl: input.connection.baseUrl
    };
    const workspace = useAnalyzeWorkerWorkspaceAdapter({
        pendingRef,
        boundaryRef,
        navigateIdentity: (identity) =>
            inputRef.current.navigate(
                analyzeImportedIdentityPatch(identity)
            )
    });
    const workspaceRef = useRef(workspace);
    workspaceRef.current = workspace;
    generationRef.current = Math.max(
        generationRef.current,
        workspace.state.operationGeneration
    );

    useEffect(() => {
        const pending = pendingRef.current;
        const pendingOwnsRenderedBoundary = pending?.authority.action === 'load-control' &&
            pending.authority.contextKey === input.context?.key &&
            pending.controlExecution === input.connection.execution;
        if (pending?.authority.action === 'load-control' && !pendingOwnsRenderedBoundary) {
            pending.controller.abort();
            workspaceRef.current.currentClient()?.cancelCandidate('replacement');
            pendingRef.current = undefined;
            pending.resolve(false);
        }
        workspace.setState((previous) => {
            if (previous.contextKey !== input.context?.key) {
                return reconcileAnalyzeWorkspaceContext(previous, input.context);
            }
            if (
                previous.activeOperation?.action === 'load-control' &&
                !pendingOwnsRenderedBoundary
            ) {
                return failAnalyzeWorkspaceOperation(
                    previous,
                    previous.activeOperation,
                    createAnalyzeInterruptedError('Analyze control source changed.')
                );
            }
            return previous;
        });
    }, [input.connection.execution, input.context, workspace.setState]);

    const perform = useCallback(async (
        action: AnalyzeWorkspaceAction,
        operationContext: AnalyzeWorkspaceContext | undefined,
        loadOffer: (signal: AbortSignal) => Promise<AnalyzeWorkerArtifactOffer>
    ): Promise<boolean> => {
        if (pendingRef.current) {
            return false;
        }
        const contextKey = action === 'load-control'
            ? operationContext?.key
            : 'local-import';
        if (!contextKey) {
            return false;
        }
        const controller = new AbortController();
        const generation = ++generationRef.current;
        const authority: AnalyzeWorkspaceOperationAuthority = {
            action,
            contextKey,
            generation,
            ...(action === 'load-control'
                ? {
                    expectedControlRunId: operationContext?.controlRunId,
                    expectedDistributedRunId: operationContext?.distributedRunId
                }
                : {})
        };
        let resolveCompletion!: (value: boolean) => void;
        const completion = new Promise<boolean>((resolve) => {
            resolveCompletion = resolve;
        });
        pendingRef.current = {
            controller,
            authority,
            resolve: resolveCompletion,
            ...(action === 'load-control'
                ? { controlExecution: inputRef.current.connection.execution }
                : {})
        };
        const activeWorkspace = workspaceRef.current;
        activeWorkspace.setState((previous) =>
            beginAnalyzeWorkspaceOperation(
                action === 'load-control'
                    ? reconcileAnalyzeWorkspaceContext(previous, operationContext)
                    : previous,
                {
                    action,
                    contextKey,
                    expectedControlRunId: authority.expectedControlRunId,
                    expectedDistributedRunId: authority.expectedDistributedRunId
                },
                generation
            ).state
        );
        activeWorkspace.setPendingPaintGeneration(undefined);
        try {
            const offer = await loadOffer(controller.signal);
            if (controller.signal.aborted || pendingRef.current?.authority !== authority) {
                throw createAnalyzeInterruptedError('Artifact operation was interrupted.');
            }
            const client = await activeWorkspace.ensureClient();
            if (controller.signal.aborted || pendingRef.current?.authority !== authority) {
                throw createAnalyzeInterruptedError('Artifact operation was interrupted.');
            }
            client.offer(offer, generation);
        }
        catch (error) {
            if (pendingRef.current?.authority === authority) {
                activeWorkspace.setState((previous) =>
                    failAnalyzeWorkspaceOperation(
                        previous,
                        authority,
                        error
                    )
                );
                pendingRef.current = undefined;
                resolveCompletion(false);
            }
        }
        return completion;
    }, []);

    const importFiles = useCallback(async (
        files: readonly AnalyzeImportFile[]
    ): Promise<boolean> => {
        if (files.length === 0) {
            return false;
        }
        return perform('import-local', undefined, async (signal) => {
            const offer = await createAnalyzeLocalOffer(files, Date.now());
            if (signal.aborted) {
                throw createAnalyzeInterruptedError('Artifact import was interrupted.');
            }
            return offer;
        });
    }, [perform]);

    const loadControlArtifact = useCallback(async (): Promise<boolean> => {
        const { connection } = inputRef.current;
        const execution = connection.execution;
        const context = currentOperationContext();
        if (!execution || !context) {
            return false;
        }
        boundaryRef.current = {
            ...boundaryRef.current,
            contextKey: context.key
        };
        return perform('load-control', context, async (signal) => {
            const [bundle, expectedControlIdentity] = await Promise.all([
                execution.exportRunArtifactBytes({
                    distributedRunId: context.distributedRunId,
                    signal
                }),
                createAnalyzeControlIdentityDigest({
                    distributedRunId: context.distributedRunId,
                    controlRunId: context.controlRunId
                })
            ]);
            const boundary = boundaryRef.current;
            if (
                signal.aborted || boundary.currentContextKey() !== context.key ||
                boundary.execution !== execution
            ) {
                throw createAnalyzeInterruptedError(
                    'Analyze control source changed while the artifact was loading.'
                );
            }
            return {
                source: 'control',
                label: boundedText(
                    `Control artifact ${context.distributedRunId}`,
                    MAX_METADATA_BYTES
                ),
                files: [],
                controlEnvelope: bundle.bytes,
                expectedControlIdentity
            };
        });
    }, [perform]);

    const search = useCallback((
        query: DistributedArtifactEvidenceWindowQuery,
        fingerprint: string
    ) => workspaceRef.current.searchEvidence(query, fingerprint), []);
    const requestWindow = useCallback((
        query: DistributedArtifactEvidenceWindowQuery,
        cursor: string,
        fingerprint: string
    ) => workspaceRef.current.requestEvidenceWindow(
        query,
        cursor,
        fingerprint
    ), []);
    const requestTune = useCallback((
        tune: Parameters<AnalyzeWorkerClient['tune']>[0]
    ) => workspaceRef.current.currentClient()?.tune(tune), []);
    const exportArtifact = useCallback(() => {
        downloadRetainedExport(workspaceRef.current.currentExport());
    }, []);

    return {
        ...workspace,
        importFiles,
        loadControlArtifact,
        search,
        requestWindow,
        requestTune,
        exportArtifact
    } as const;
}

function downloadRetainedExport(
    retained: ReturnType<AnalyzeWorkerClient['currentExport']>
): void {
    if (!retained || typeof document === 'undefined') {
        return;
    }
    const href = URL.createObjectURL(retained.blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = retained.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
}

export type { AnalyzeImportFile } from './analyze-local-offer.ts';
