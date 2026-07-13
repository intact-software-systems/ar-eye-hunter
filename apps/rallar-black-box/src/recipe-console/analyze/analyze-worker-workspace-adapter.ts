import { useCallback, useEffect, useRef, useState } from 'react';
import type { DistributedArtifactEvidenceWindowQuery } from
    '@shared-test/rallar-bb-test/mod.ts';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import { analyzeOperationOwnsCurrentBoundary } from
    './analyze-operation-boundary.ts';
import { createAnalyzeInterruptedError } from './analyze-workspace-policy.ts';
import {
    clearAnalyzeWorkspaceArtifact, selectAnalyzeWorkspaceEvidence,
    createInitialAnalyzeWorkspaceState, type AnalyzeWorkspaceOperationAuthority,
} from './analyze-workspace-state.ts';
import type {
    AnalyzeArtifactProjection, AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade, AnalyzeWorkerTelemetry,
} from './analyze-worker-contract.ts';
import type { AnalyzeWorkerClient } from './analyze-worker-client.ts';
import { useAnalyzeEvidenceRequests } from './use-analyze-evidence-requests.ts';
import {
    createAnalyzeWorkerWorkspaceCallbacks,
    type AnalyzePendingIdentityPatch,
} from './analyze-worker-workspace-callbacks.ts';

export type AnalyzePendingOperation = Readonly<{
    controller: AbortController;
    authority: AnalyzeWorkspaceOperationAuthority;
    controlExecution?: RecipeConsoleControlConnection['execution'];
    resolve(value: boolean): void;
}>;
export type AnalyzeControlBoundary = Readonly<{
    contextKey?: string;
    currentContextKey(): string | undefined;
    execution?: RecipeConsoleControlConnection['execution'];
    baseUrl: string;
}>;
export type AnalyzeMutableRef<Value> = { current: Value };
export function useAnalyzeWorkerWorkspaceAdapter(input: Readonly<{
    pendingRef: AnalyzeMutableRef<AnalyzePendingOperation | undefined>;
    boundaryRef: AnalyzeMutableRef<AnalyzeControlBoundary>;
    navigateIdentity(identity: AnalyzeArtifactProjection['identity']): void;
}>) {
    const [state, setState] = useState(
        createInitialAnalyzeWorkspaceState<AnalyzeArtifactProjection>,
    );
    const evidence = useAnalyzeEvidenceRequests();
    const [selectedEvidence, setSelectedEvidence] = useState<
        AnalyzeEvidenceWindowProjection['entries'][number]
    >();
    const [tuneFacade, setTuneFacade] = useState<AnalyzeTuneArtifactFacade>();
    const [telemetry, setTelemetry] = useState<AnalyzeWorkerTelemetry>();
    const [workerUnavailable, setWorkerUnavailable] = useState<string>();
    const [pendingPaintGeneration, setPendingPaintGeneration] = useState<number>();
    const clientRef = useRef<AnalyzeWorkerClient | undefined>(undefined);
    const clientPromiseRef = useRef<Promise<AnalyzeWorkerClient> | undefined>(undefined);
    const lifetimeRef = useRef(0);
    const validationErrorRef = useRef<Error | undefined>(undefined);
    const pendingIdentityPatchRef = useRef<
        AnalyzePendingIdentityPatch | undefined
    >(undefined);
    const navigateIdentityRef = useRef(input.navigateIdentity);
    navigateIdentityRef.current = input.navigateIdentity;
    const ensureClient = useCallback(async (): Promise<AnalyzeWorkerClient> => {
        if (clientRef.current) return clientRef.current;
        const lifetime = lifetimeRef.current;
        clientPromiseRef.current ??= Promise.all([
            import('./analyze-worker-client.ts'),
            import('./analyze-worker-factory.ts'),
        ]).then(([clientModule, factoryModule]) => {
            const client = clientModule.createAnalyzeWorkerClient({
                createWorker: factoryModule.createAnalyzeWorkerFactory(),
                performance: typeof performance === 'undefined' ? undefined : performance,
                validateComplete(response) {
                    const pending = input.pendingRef.current;
                    if (pending?.authority.generation !== response.operationGeneration) {
                        return false;
                    }
                    const boundary = input.boundaryRef.current;
                    if (!analyzeOperationOwnsCurrentBoundary({
                        authority: pending.authority,
                        operationExecution: pending.controlExecution,
                        currentContextKey: boundary.currentContextKey(),
                        currentExecution: boundary.execution,
                    })) {
                        validationErrorRef.current = createAnalyzeInterruptedError(
                            'Analyze control source changed before artifact promotion.',
                        );
                        return false;
                    }
                    if (pending.authority.action !== 'load-control') return true;
                    if (response.controlIdentityValidated === true) {
                        validationErrorRef.current = undefined;
                        return true;
                    }
                    validationErrorRef.current = new Error(
                        'Artifact identity was not validated against the active control source.',
                    );
                    return false;
                },
                callbacks: createAnalyzeWorkerWorkspaceCallbacks({
                    pendingRef: input.pendingRef,
                    validationErrorRef,
                    pendingIdentityPatchRef,
                    setState,
                    evidence,
                    setSelectedEvidence,
                    setTuneFacade,
                    setTelemetry,
                    setWorkerUnavailable,
                    setPendingPaintGeneration,
                }),
            });
            if (lifetime !== lifetimeRef.current) {
                client.dispose();
                throw createAnalyzeInterruptedError('Analyze workspace was disposed before its worker loaded.');
            }
            clientRef.current = client;
            return client;
        }).catch(error => {
            if (lifetime === lifetimeRef.current) {
                clientPromiseRef.current = undefined;
            }
            throw error;
        });
        return clientPromiseRef.current;
    }, [input.boundaryRef, input.pendingRef]);
    useEffect(() => () => {
        lifetimeRef.current += 1;
        clientPromiseRef.current = undefined;
        input.pendingRef.current?.controller.abort();
        input.pendingRef.current?.resolve(false);
        input.pendingRef.current = undefined;
        clientRef.current?.dispose();
        clientRef.current = undefined;
    }, [input.pendingRef]);
    useEffect(() => {
        const patch = pendingIdentityPatchRef.current;
        if (
            !patch || !state.artifact ||
            patch.generation !== state.operationGeneration ||
            patch.identity.distributedRunId !== state.artifact.identity.distributedRunId
        ) return;
        pendingIdentityPatchRef.current = undefined;
        navigateIdentityRef.current(patch.identity);
    }, [state.artifact, state.operationGeneration]);
    const clearArtifact = useCallback(() => {
        input.pendingRef.current?.controller.abort();
        input.pendingRef.current?.resolve(false);
        input.pendingRef.current = undefined;
        clientRef.current?.clear();
        pendingIdentityPatchRef.current = undefined;
        evidence.clear();
        setSelectedEvidence(undefined);
        setTuneFacade(undefined);
        setTelemetry(undefined);
        setWorkerUnavailable(undefined);
        setPendingPaintGeneration(undefined);
        setState(clearAnalyzeWorkspaceArtifact);
    }, [evidence.clear, input.pendingRef]);
    const selectEvidence = useCallback((id: string | undefined) => {
        setState(previous => selectAnalyzeWorkspaceEvidence(previous, id));
        setSelectedEvidence(evidence.window?.entries.find(row => row.id === id));
        clientRef.current?.select(id);
    }, [evidence.window]);
    const searchEvidence = useCallback((
        query: DistributedArtifactEvidenceWindowQuery,
        fingerprint: string,
    ) => evidence.begin({
        fingerprint,
        kind: 'search',
        send: () => clientRef.current?.search(query),
    }), [evidence.begin]);
    const requestEvidenceWindow = useCallback((
        query: DistributedArtifactEvidenceWindowQuery,
        cursor: string,
        fingerprint: string,
    ) => evidence.begin({
        fingerprint,
        kind: 'window',
        send: () => clientRef.current?.window({ query, cursor }),
    }), [evidence.begin]);
    return {
        state,
        setState,
        evidenceWindow: evidence.window,
        evidenceWindowFingerprint: evidence.windowFingerprint,
        evidenceWindowPending: evidence.pending,
        evidenceWindowError: evidence.error,
        selectedEvidence,
        tuneFacade,
        telemetry,
        workerUnavailable,
        pendingPaintGeneration,
        setPendingPaintGeneration,
        ensureClient,
        currentClient: () => clientRef.current,
        clearArtifact,
        selectEvidence,
        searchEvidence,
        requestEvidenceWindow,
        currentExport: () => clientRef.current?.currentExport(),
    } as const;
}
