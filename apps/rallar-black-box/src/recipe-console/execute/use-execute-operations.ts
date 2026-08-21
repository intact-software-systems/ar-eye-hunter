import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';
import type { ExecuteAction, ExecuteActionPolicy } from './execute-action-policy.ts';
import { downloadExecuteArtifact } from './execute-artifact-export.ts';
import {
    createExecuteTargetResolutionEvidence,
    projectExecuteManifest,
    type ExecuteManifestDraft,
    type ExecuteTargetResolutionEvidence
} from './execute-manifest.ts';
import { projectExecuteOperationError, type ExecuteOperationError } from './execute-operation-error.ts';
import { executeOperationContextKey } from './execute-workflow-context.ts';
import { classifyExecuteMutationResponse } from './execute-workflow-state.ts';

export type BoundExecuteResolution = Readonly<{
    contextKey: string;
    evidence: ExecuteTargetResolutionEvidence;
}>;
export type BoundExecuteOptimisticRun = Readonly<{
    contextKey: string;
    run: ControlDistributedRunSnapshot;
}>;

export function useExecuteOperations(
    input: Readonly<{
        connection: RecipeConsoleControlConnection;
        manifest?: ExecuteManifestDraft;
        run?: ControlDistributedRunSnapshot;
        policy: ExecuteActionPolicy;
        operationContextKey: string;
        truthContextKey: string;
        navigate(patch: Partial<RecipeConsoleUrlState>): void;
        setResolution: Dispatch<SetStateAction<BoundExecuteResolution | undefined>>;
        setOptimisticRun: Dispatch<SetStateAction<BoundExecuteOptimisticRun | undefined>>;
    }>
) {
    const [busyAction, setBusyAction] = useState<ExecuteAction>();
    const [mutationError, setMutationError] = useState<ExecuteOperationError>();
    const [cancelOpen, setCancelOpen] = useState(false);
    const [startOpen, setStartOpen] = useState(false);
    const requestRef = useRef<AbortController | undefined>(undefined);
    const operationContextRef = useRef(input.operationContextKey);
    operationContextRef.current = input.operationContextKey;

    useEffect(() => {
        setMutationError(undefined);
        setCancelOpen(false);
        setStartOpen(false);
        return () => requestRef.current?.abort();
    }, [input.connection.execution, input.operationContextKey]);
    useEffect(() => {
        if (!input.policy.cancel.enabled && busyAction !== 'cancel') {
            setCancelOpen(false);
        }
    }, [busyAction, input.policy.cancel.enabled]);
    useEffect(() => {
        if (!input.policy.start.enabled && busyAction !== 'start') {
            setStartOpen(false);
        }
    }, [busyAction, input.policy.start.enabled]);
    const perform = useCallback(async (
        action: ExecuteAction,
        operation: (signal: AbortSignal) => Promise<void>,
        refreshMode: 'await' | 'background' | 'none' = 'await'
    ): Promise<boolean> => {
        if (requestRef.current) {
            return false;
        }
        const controller = new AbortController();
        requestRef.current = controller;
        setBusyAction(action);
        setMutationError(undefined);
        let succeeded = false;
        try {
            await operation(controller.signal);
            succeeded = true;
        }
        catch (error) {
            if (
                !controller.signal.aborted &&
                operationContextRef.current === input.operationContextKey
            ) {
                setMutationError(projectExecuteOperationError(error));
            }
        }
        finally {
            const shouldRefresh = refreshMode !== 'none' && !controller.signal.aborted &&
                operationContextRef.current === input.operationContextKey;
            if (shouldRefresh && refreshMode === 'await') {
                await input.connection.refreshAfterCurrent();
            }
            else if (shouldRefresh) {
                void input.connection.refreshAfterCurrent().catch(() => undefined);
            }
            if (requestRef.current === controller) {
                requestRef.current = undefined;
                setBusyAction(undefined);
            }
        }
        return succeeded;
    }, [input.connection.refreshAfterCurrent, input.operationContextKey]);

    const resolveFresh = useCallback(async (signal: AbortSignal) => {
        const execution = requiredExecution(input.connection);
        if (!input.manifest) {
            throw new Error('A valid generated manifest is required.');
        }
        const result = await execution.resolveTargets({
            manifest: input.manifest.manifest,
            signal
        });
        assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
        const evidence = createExecuteTargetResolutionEvidence({
            manifest: input.manifest.manifest,
            resolution: result
        });
        input.setResolution({ contextKey: input.operationContextKey, evidence });
        if (!evidence.comparison.ok) {
            throw new Error(evidence.comparison.issues.map((issue) => issue.message).join(' '));
        }
    }, [input.connection, input.manifest, input.operationContextKey, input.setResolution]);

    const acceptRun = useCallback((
        action: 'create' | 'stage' | 'start' | 'cancel',
        value: ControlDistributedRunSnapshot
    ) => {
        assertRunIdentity(
            value,
            input.manifest?.manifest.distributedRunId,
            input.manifest?.manifest.controlRunId
        );
        const result = classifyExecuteMutationResponse(action, value);
        input.setResolution((previous) =>
            rebindResolution(
                previous,
                result.run,
                input.truthContextKey
            )
        );
        input.setOptimisticRun({
            contextKey: input.truthContextKey,
            run: result.run
        });
        input.navigate({
            distributedRunId: result.run.distributedRunId,
            commandId: undefined
        });
        if (!result.ok) {
            throw new Error(result.reason);
        }
    }, [
        input.manifest,
        input.navigate,
        input.setOptimisticRun,
        input.setResolution,
        input.truthContextKey
    ]);

    async function resolveTargets(): Promise<void> {
        if (!input.policy.resolve.enabled) {
            return;
        }
        await perform('resolve', async (signal) => void await resolveFresh(signal), 'background');
    }
    async function createRun(): Promise<void> {
        if (!input.policy.create.enabled || !input.manifest) {
            return;
        }
        await perform('create', async (signal) => {
            await resolveFresh(signal);
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            const result = await requiredExecution(input.connection).createRun({
                manifest: input.manifest!.manifest,
                signal
            });
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            acceptRun('create', result);
        });
    }
    async function stageRun(): Promise<void> {
        if (!input.policy.stage.enabled || !input.run) {
            return;
        }
        await perform('stage', async (signal) => {
            await resolveFresh(signal);
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            const result = await requiredExecution(input.connection).stageRun({
                distributedRunId: input.run!.distributedRunId,
                signal
            });
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            acceptRun('stage', result);
        });
    }
    async function startRun(): Promise<void> {
        if (!input.policy.start.enabled || !input.run) {
            return;
        }
        const succeeded = await perform('start', async (signal) => {
            const result = await requiredExecution(input.connection).startRun({
                distributedRunId: input.run!.distributedRunId,
                signal
            });
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            acceptRun('start', result);
        });
        if (succeeded) {
            setStartOpen(false);
        }
    }
    async function confirmCancel(): Promise<void> {
        if (!input.policy.cancel.enabled || !input.run) {
            return;
        }
        const succeeded = await perform('cancel', async (signal) => {
            const result = await requiredExecution(input.connection).cancelRun({
                distributedRunId: input.run!.distributedRunId,
                reason: 'Cancelled by Recipe Console operator.',
                signal
            });
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            acceptRun('cancel', result);
        });
        if (succeeded) {
            setCancelOpen(false);
        }
    }
    async function exportArtifact(): Promise<void> {
        if (!input.policy.export.enabled || !input.run) {
            return;
        }
        await perform('export', async (signal) => {
            const artifact = await requiredExecution(input.connection).exportRunArtifact({
                distributedRunId: input.run!.distributedRunId,
                signal
            });
            assertCurrentOperation(signal, operationContextRef, input.operationContextKey);
            if (artifact.distributedRunId !== input.run!.distributedRunId) {
                throw new Error('Artifact response belongs to a different distributed run.');
            }
            downloadExecuteArtifact(artifact, input.run!.distributedRunId);
        }, 'none');
    }

    return {
        busyAction,
        mutationError,
        cancelOpen,
        startOpen,
        resolveTargets,
        createRun,
        stageRun,
        startRun,
        requestStart: () => {
            if (input.policy.start.enabled) {
                setStartOpen(true);
            }
        },
        closeStart: () => setStartOpen(false),
        requestCancel: () => setCancelOpen(true),
        closeCancel: () => setCancelOpen(false),
        confirmCancel,
        refresh: input.connection.refresh,
        exportArtifact
    } as const;
}

function requiredExecution(connection: RecipeConsoleControlConnection) {
    if (!connection.execution) {
        throw new Error('The control execution endpoint is unavailable.');
    }
    return connection.execution;
}

function assertCurrentOperation(
    signal: AbortSignal,
    contextRef: Readonly<{ current: string; }>,
    expectedContextKey: string
): void {
    if (signal.aborted) {
        throw new DOMException('Execute action aborted.', 'AbortError');
    }
    if (!expectedContextKey || contextRef.current !== expectedContextKey) {
        throw new Error('Execute configuration changed while the action was in progress.');
    }
}

function assertRunIdentity(
    run: ControlDistributedRunSnapshot,
    distributedRunId: string | undefined,
    controlRunId: string | undefined
): void {
    if (
        !distributedRunId || !controlRunId ||
        run.distributedRunId !== distributedRunId ||
        run.controlRunId !== controlRunId
    ) {
        throw new Error('Control response identity does not match the requested distributed run.');
    }
}

function rebindResolution(
    previous: BoundExecuteResolution | undefined,
    run: ControlDistributedRunSnapshot,
    truthContextKey: string
): BoundExecuteResolution | undefined {
    if (!previous) {
        return undefined;
    }
    const projected = projectExecuteManifest(run.manifest);
    const evidence = createExecuteTargetResolutionEvidence({
        manifest: run.manifest,
        resolution: previous.evidence.resolution
    });
    return evidence.comparison.ok
        ? {
            contextKey: executeOperationContextKey(
                truthContextKey,
                projected.fingerprint
            ),
            evidence
        }
        : undefined;
}
