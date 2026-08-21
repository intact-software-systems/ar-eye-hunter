export type AnalyzeArtifactIdentity = Readonly<{
    distributedRunId: string;
    controlRunId?: string;
}>;

export type AnalyzeWorkspaceAction = 'import-local' | 'load-control';

export type AnalyzeWorkspaceContext = Readonly<{
    key: string;
    baseUrl: string;
    controlRunId?: string;
    distributedRunId: string;
}>;

export type AnalyzeWorkspaceOperationAuthority = Readonly<{
    action: AnalyzeWorkspaceAction;
    contextKey: string;
    expectedControlRunId?: string;
    expectedDistributedRunId?: string;
    generation: number;
}>;

export type AnalyzeWorkspaceState<Artifact extends AnalyzeArtifactIdentity> = Readonly<{
    contextKey?: string;
    artifact?: Artifact;
    artifactContextKey?: string;
    artifactStatus: 'idle' | 'pending' | 'ready' | 'error';
    selectedEvidenceId?: string;
    operationGeneration: number;
    activeOperation?: AnalyzeWorkspaceOperationAuthority;
    operationError?: unknown;
}>;

export function createAnalyzeWorkspaceContext(
    input: Readonly<{
        baseUrl: string;
        controlRunId?: string;
        distributedRunId: string;
    }>
): AnalyzeWorkspaceContext {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    const identity = compact({
        baseUrl,
        controlRunId: input.controlRunId,
        distributedRunId: input.distributedRunId
    });
    return { key: JSON.stringify(identity), ...identity };
}

export function createInitialAnalyzeWorkspaceState<Artifact extends AnalyzeArtifactIdentity>(): AnalyzeWorkspaceState<
    Artifact
> {
    return {
        artifactStatus: 'idle',
        operationGeneration: 0
    };
}

export function reconcileAnalyzeWorkspaceContext<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    context: AnalyzeWorkspaceContext | undefined
): AnalyzeWorkspaceState<Artifact> {
    if (state.contextKey === context?.key) {
        return state;
    }
    if (state.activeOperation?.action !== 'load-control') {
        return reconcileRetainedArtifactContext(state, context);
    }
    const error = abortError(
        'Analyze control artifact load was interrupted by a context change.'
    );
    return {
        ...state,
        contextKey: context?.key,
        artifactStatus: 'error',
        operationGeneration: Math.max(
            state.operationGeneration + 1,
            state.activeOperation.generation + 1
        ),
        activeOperation: undefined,
        operationError: error
    };
}

export function beginAnalyzeWorkspaceOperation<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    input: Omit<AnalyzeWorkspaceOperationAuthority, 'generation'>,
    requestedGeneration = state.operationGeneration + 1
): Readonly<{
    state: AnalyzeWorkspaceState<Artifact>;
    authority: AnalyzeWorkspaceOperationAuthority;
}> {
    const generation = Math.max(
        requestedGeneration,
        state.operationGeneration + 1
    );
    const authority = { ...input, generation };
    if (
        input.action === 'load-control' &&
        state.contextKey !== input.contextKey
    ) {
        return { state, authority };
    }
    return {
        authority,
        state: {
            ...state,
            artifactStatus: 'pending',
            operationGeneration: generation,
            activeOperation: authority,
            operationError: undefined
        }
    };
}

export function completeAnalyzeWorkspaceOperation<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    authority: AnalyzeWorkspaceOperationAuthority,
    completion: Readonly<{
        artifact: Artifact;
        selectedEvidenceId?: string;
        controlIdentityValidated?: boolean;
    }>
): AnalyzeWorkspaceState<Artifact> {
    if (!hasAnalyzeWorkspaceAuthority(state, authority)) {
        return state;
    }
    const exactControlIdentityValidated = authority.action === 'load-control' &&
        completion.controlIdentityValidated === true;
    if (
        !exactControlIdentityValidated &&
        authority.expectedDistributedRunId &&
        completion.artifact.distributedRunId !==
            authority.expectedDistributedRunId
    ) {
        return failWithAuthority(
            state,
            new Error(
                `Artifact response belongs to ${completion.artifact.distributedRunId}, not ${authority.expectedDistributedRunId}.`
            )
        );
    }
    if (
        !exactControlIdentityValidated &&
        authority.expectedControlRunId &&
        completion.artifact.controlRunId !== authority.expectedControlRunId
    ) {
        return failWithAuthority(
            state,
            new Error(
                `Artifact response belongs to control run ${
                    completion.artifact.controlRunId ?? 'unknown'
                }, not ${authority.expectedControlRunId}.`
            )
        );
    }
    return {
        ...state,
        artifact: completion.artifact,
        artifactContextKey: authority.action === 'load-control'
            ? authority.contextKey
            : undefined,
        artifactStatus: 'ready',
        selectedEvidenceId: completion.selectedEvidenceId,
        activeOperation: undefined,
        operationError: undefined
    };
}

export function failAnalyzeWorkspaceOperation<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    authority: AnalyzeWorkspaceOperationAuthority,
    error: unknown
): AnalyzeWorkspaceState<Artifact> {
    return hasAnalyzeWorkspaceAuthority(state, authority)
        ? failWithAuthority(state, error)
        : state;
}

export function clearAnalyzeWorkspaceArtifact<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>
): AnalyzeWorkspaceState<Artifact> {
    return {
        contextKey: state.contextKey,
        artifactStatus: 'idle',
        operationGeneration: state.operationGeneration + 1
    };
}

function reconcileRetainedArtifactContext<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    context: AnalyzeWorkspaceContext | undefined
): AnalyzeWorkspaceState<Artifact> {
    const next = { ...state, contextKey: context?.key };
    if (!state.artifact) {
        return next;
    }

    const mismatch = retainedArtifactContextError(state, context);
    if (mismatch) {
        return {
            ...next,
            artifactStatus: 'error',
            operationError: mismatch
        };
    }
    if (state.operationError instanceof AnalyzeArtifactContextError) {
        return {
            ...next,
            artifactStatus: 'ready',
            operationError: undefined
        };
    }
    return next;
}

function retainedArtifactContextError<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    context: AnalyzeWorkspaceContext | undefined
): Error | undefined {
    const artifact = state.artifact;
    if (!artifact) {
        return undefined;
    }
    if (!context) {
        return new AnalyzeArtifactContextError(
            `Loaded artifact ${artifact.distributedRunId} is retained, but no distributed run is selected.`
        );
    }
    if (state.artifactContextKey) {
        return state.artifactContextKey === context.key
            ? undefined
            : new AnalyzeArtifactContextError(
                `Loaded control artifact ${artifact.distributedRunId} is retained from another control context; load ${context.distributedRunId} to replace it.`
            );
    }
    if (artifact.distributedRunId !== context.distributedRunId) {
        return new AnalyzeArtifactContextError(
            `Loaded artifact ${artifact.distributedRunId} does not match selected distributed run ${context.distributedRunId}; previous analysis is retained.`
        );
    }
    if (
        artifact.controlRunId && context.controlRunId &&
        artifact.controlRunId !== context.controlRunId
    ) {
        return new AnalyzeArtifactContextError(
            `Loaded artifact belongs to control run ${artifact.controlRunId}, not selected control run ${context.controlRunId}; previous analysis is retained.`
        );
    }
    return undefined;
}

class AnalyzeArtifactContextError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AnalyzeArtifactContextError';
    }
}

export function selectAnalyzeWorkspaceEvidence<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    selectedEvidenceId: string | undefined
): AnalyzeWorkspaceState<Artifact> {
    return state.selectedEvidenceId === selectedEvidenceId
        ? state
        : { ...state, selectedEvidenceId };
}

export function hasAnalyzeWorkspaceAuthority(
    state: AnalyzeWorkspaceState<AnalyzeArtifactIdentity>,
    authority: AnalyzeWorkspaceOperationAuthority
): boolean {
    const active = state.activeOperation;
    return active?.action === authority.action &&
        active.contextKey === authority.contextKey &&
        active.generation === authority.generation;
}

function failWithAuthority<Artifact extends AnalyzeArtifactIdentity>(
    state: AnalyzeWorkspaceState<Artifact>,
    error: unknown
): AnalyzeWorkspaceState<Artifact> {
    return {
        ...state,
        artifactStatus: 'error',
        activeOperation: undefined,
        operationError: error
    };
}

function abortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function compact<Value extends Record<string, unknown>>(value: Value): Value {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    ) as Value;
}
