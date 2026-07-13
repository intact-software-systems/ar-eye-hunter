import {
    useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction,
} from 'react';
import { flushSync } from 'react-dom';
import type { RecipeConsoleControlConnection } from
    '../control/ControlConnectionProvider.tsx';
import { analyzeOperationOwnsCurrentBoundary } from
    './analyze-operation-boundary.ts';
import { createAnalyzeInterruptedError } from './analyze-workspace-policy.ts';
import {
    clearAnalyzeWorkspaceArtifact, completeAnalyzeWorkspaceOperation,
    failAnalyzeWorkspaceOperation, selectAnalyzeWorkspaceEvidence,
    createInitialAnalyzeWorkspaceState, type AnalyzeWorkspaceOperationAuthority,
    type AnalyzeWorkspaceState,
} from './analyze-workspace-state.ts';
import type {
    AnalyzeArtifactProjection, AnalyzeEvidenceWindowProjection,
    AnalyzeTuneArtifactFacade, AnalyzeWorkerErrorProjection, AnalyzeWorkerTelemetry,
} from './analyze-worker-contract.ts';
import type { AnalyzeWorkerClient, AnalyzeWorkerClientCallbacks } from
    './analyze-worker-client.ts';
import { analyzeWorkerError } from './analyze-worker-error.ts';
import { analyzeCompletionNavigationIdentity } from
    './analyze-completion-navigation.ts';

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
    const [evidenceWindow, setEvidenceWindow] = useState<AnalyzeEvidenceWindowProjection>();
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
    const pendingIdentityPatchRef = useRef<PendingIdentityPatch | undefined>(undefined);
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
                callbacks: createWorkerCallbacks({
                    pendingRef: input.pendingRef,
                    validationErrorRef,
                    pendingIdentityPatchRef,
                    setState,
                    setEvidenceWindow,
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
        setEvidenceWindow(undefined);
        setSelectedEvidence(undefined);
        setTuneFacade(undefined);
        setTelemetry(undefined);
        setWorkerUnavailable(undefined);
        setPendingPaintGeneration(undefined);
        setState(clearAnalyzeWorkspaceArtifact);
    }, [input.pendingRef]);
    const selectEvidence = useCallback((id: string | undefined) => {
        setState(previous => selectAnalyzeWorkspaceEvidence(previous, id));
        setSelectedEvidence(evidenceWindow?.entries.find(row => row.id === id));
        clientRef.current?.select(id);
    }, [evidenceWindow]);
    return {
        state,
        setState,
        evidenceWindow,
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
        currentExport: () => clientRef.current?.currentExport(),
    } as const;
}

type WorkerCallbackInput = Readonly<{
    pendingRef: AnalyzeMutableRef<AnalyzePendingOperation | undefined>;
    validationErrorRef: AnalyzeMutableRef<Error | undefined>;
    pendingIdentityPatchRef: AnalyzeMutableRef<PendingIdentityPatch | undefined>;
    setState: StateSetter<AnalyzeWorkspaceState<AnalyzeArtifactProjection>>;
    setEvidenceWindow: StateSetter<AnalyzeEvidenceWindowProjection | undefined>;
    setSelectedEvidence: StateSetter<
        AnalyzeEvidenceWindowProjection['entries'][number] | undefined
    >;
    setTuneFacade: StateSetter<AnalyzeTuneArtifactFacade | undefined>;
    setTelemetry: StateSetter<AnalyzeWorkerTelemetry | undefined>;
    setWorkerUnavailable: StateSetter<string | undefined>;
    setPendingPaintGeneration: StateSetter<number | undefined>;
}>;
type StateSetter<Value> = Dispatch<SetStateAction<Value>>;
type PendingIdentityPatch = Readonly<{
    generation: number;
    identity: AnalyzeArtifactProjection['identity'];
}>;

function createWorkerCallbacks(
    input: WorkerCallbackInput,
): AnalyzeWorkerClientCallbacks {
    return {
        onPendingPaint(generation: number) {
            flushSync(() => input.setPendingPaintGeneration(generation));
        },
        onComplete(response) {
            const pending = input.pendingRef.current;
            if (pending?.authority.generation !== response.operationGeneration) return;
            const navigationIdentity = analyzeCompletionNavigationIdentity({
                action: pending.authority.action,
                expectedDistributedRunId: pending.authority.expectedDistributedRunId,
                expectedControlRunId: pending.authority.expectedControlRunId,
                projection: response.projection.identity,
            });
            input.pendingIdentityPatchRef.current = navigationIdentity
                ? { generation: response.operationGeneration, identity: navigationIdentity }
                : undefined;
            input.setEvidenceWindow(response.initialWindow);
            input.setSelectedEvidence(response.selected);
            input.setTuneFacade(undefined);
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
            input.setState(previous => completeAnalyzeWorkspaceOperation(
                previous,
                pending.authority,
                {
                    artifact: response.projection,
                    selectedEvidenceId: response.selected?.id ??
                        response.projection.firstActionableEvidenceId,
                    controlIdentityValidated: response.controlIdentityValidated,
                },
            ));
            input.pendingRef.current = undefined;
            input.setPendingPaintGeneration(undefined);
            pending.resolve(true);
        },
        onSearchComplete(response) {
            input.setEvidenceWindow(response.window);
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
            input.setSelectedEvidence(previous => previous &&
                response.window.entries.some(row => row.id === previous.id)
                ? previous
                : undefined);
        },
        onWindowComplete(response) {
            input.setEvidenceWindow(response.window);
            input.setTelemetry(response.telemetry);
            input.setWorkerUnavailable(undefined);
        },
        onSelectionComplete(response) {
            input.setSelectedEvidence(response.selected);
        },
        onTuneComplete(response) {
            input.setTuneFacade(response.facade);
            input.setWorkerUnavailable(undefined);
        },
        onFailure(error: AnalyzeWorkerErrorProjection, operationGeneration?: number) {
            const pending = input.pendingRef.current;
            if (!pending || pending.authority.generation !== operationGeneration) return;
            const failure = input.validationErrorRef.current ?? analyzeWorkerError(error);
            input.validationErrorRef.current = undefined;
            input.setState(previous => failAnalyzeWorkspaceOperation(
                previous,
                pending.authority,
                failure,
            ));
            input.pendingRef.current = undefined;
            pending.resolve(false);
        },
        onUnavailable(reason, scope) {
            const pending = input.pendingRef.current;
            if (scope === 'candidate' && pending) {
                input.setState(previous => failAnalyzeWorkspaceOperation(
                    previous,
                    pending.authority,
                    new Error('The Analyze worker became unavailable before the candidate completed.'),
                ));
                input.pendingRef.current = undefined;
                pending.resolve(false);
                input.setPendingPaintGeneration(undefined);
            }
            if (scope !== 'candidate') {
                input.setWorkerUnavailable(
                    `Analyze worker unavailable (${reason}); the last bounded projection and export remain available.`,
                );
            }
        },
    };
}
