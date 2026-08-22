import type { ControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { MonitorAction } from './monitor-action-policy.ts';

export type MonitorArtifactState = Readonly<{
    status: 'idle' | 'pending' | 'ready' | 'error';
    bundle?: ControlDistributedRunArtifactBundle;
    error?: string;
}>;

export type MonitorOperationAuthority = Readonly<{
    contextKey: string;
    generation: number;
    action: MonitorAction;
}>;

export type MonitorOperationState = Readonly<{
    contextKey?: string;
    artifact: MonitorArtifactState;
    operationGeneration: number;
    activeOperation?: MonitorOperationAuthority;
    operationError?: unknown;
}>;

export function createInitialMonitorOperationState(): MonitorOperationState {
    return {
        contextKey: undefined,
        artifact: { status: 'idle', bundle: undefined, error: undefined },
        operationGeneration: 0,
        activeOperation: undefined,
        operationError: undefined
    };
}

export function beginMonitorOperation<State extends MonitorOperationState>(
    state: State,
    contextKey: string,
    action: MonitorAction,
    generation = state.operationGeneration + 1
): Readonly<{ state: State; authority: MonitorOperationAuthority; }> {
    const nextGeneration = Math.max(generation, state.operationGeneration + 1);
    const authority = { contextKey, generation: nextGeneration, action };
    if (state.contextKey !== contextKey) {
        return { state, authority };
    }
    const artifactOperation = action === 'load-artifact' ||
        action === 'export-artifact';
    return {
        authority,
        state: {
            ...state,
            operationGeneration: nextGeneration,
            activeOperation: authority,
            operationError: undefined,
            artifact: artifactOperation
                ? { status: 'pending', bundle: state.artifact.bundle }
                : state.artifact
        }
    } as Readonly<{ state: State; authority: MonitorOperationAuthority; }>;
}

export function completeMonitorArtifactOperation<State extends MonitorOperationState>(
    state: State,
    authority: MonitorOperationAuthority,
    bundle: ControlDistributedRunArtifactBundle
): State {
    if (!hasMonitorOperationAuthority(state, authority)) {
        return state;
    }
    if (
        bundle.distributedRunId !== distributedRunIdFromContext(
            authority.contextKey
        )
    ) {
        return finishArtifactError(
            state,
            new Error('Artifact response belongs to a different distributed run.')
        );
    }
    return {
        ...state,
        artifact: { status: 'ready', bundle, error: undefined },
        activeOperation: undefined,
        operationError: undefined
    } as State;
}

export function completeMonitorOperation<State extends MonitorOperationState>(
    state: State,
    authority: MonitorOperationAuthority
): State {
    return hasMonitorOperationAuthority(state, authority)
        ? {
            ...state,
            activeOperation: undefined,
            operationError: undefined
        } as State
        : state;
}

export function failMonitorOperation<State extends MonitorOperationState>(
    state: State,
    authority: MonitorOperationAuthority,
    error: unknown
): State {
    if (!hasMonitorOperationAuthority(state, authority)) {
        return state;
    }
    return authority.action === 'load-artifact' ||
            authority.action === 'export-artifact'
        ? finishArtifactError(state, error)
        : {
            ...state,
            activeOperation: undefined,
            operationError: error
        } as State;
}

export function hasMonitorOperationAuthority(
    state: MonitorOperationState,
    authority: MonitorOperationAuthority
): boolean {
    const active = state.activeOperation;
    return state.contextKey === authority.contextKey &&
        active?.contextKey === authority.contextKey &&
        active.generation === authority.generation &&
        active.action === authority.action;
}

function finishArtifactError<State extends MonitorOperationState>(
    state: State,
    error: unknown
): State {
    return {
        ...state,
        artifact: {
            status: 'error',
            bundle: state.artifact.bundle,
            error: errorMessage(error)
        },
        activeOperation: undefined,
        operationError: error
    } as State;
}

function distributedRunIdFromContext(contextKey: string): string | undefined {
    try {
        const value = JSON.parse(contextKey) as { distributedRunId?: unknown; };
        return typeof value.distributedRunId === 'string'
            ? value.distributedRunId
            : undefined;
    }
    catch {
        return undefined;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
