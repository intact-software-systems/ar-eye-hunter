import type {
    ControlDistributedRunSnapshot,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type Dispatch,
    type SetStateAction,
} from 'react';
import type {
    RecipeConsoleControlConnection,
} from '../control/ControlConnectionProvider.tsx';
import {
    downloadDistributedRunArtifact,
} from '../control/distributed-run-artifact-download.ts';
import {
    projectControlOperationError,
} from '../control/control-operation-error.ts';
import type { MonitorActionPolicy } from './monitor-action-policy.ts';
import {
    beginMonitorOperation,
    completeMonitorArtifactOperation,
    completeMonitorOperation,
    failMonitorOperation,
    projectMonitorMutation,
    type MonitorOperationAuthority,
    type MonitorWorkspaceContext,
    type MonitorWorkspaceState,
} from './monitor-workspace-state.ts';

export function useMonitorOperations(input: Readonly<{
    connection: RecipeConsoleControlConnection;
    context?: MonitorWorkspaceContext;
    policy: MonitorActionPolicy;
    run?: ControlDistributedRunSnapshot;
    state: MonitorWorkspaceState;
    setState: Dispatch<SetStateAction<MonitorWorkspaceState>>;
}>) {
    const [cancelOpen, setCancelOpen] = useState(false);
    const requestRef = useRef<AbortController | undefined>(undefined);
    const generationRef = useRef(input.state.operationGeneration);
    const contextKeyRef = useRef(input.context?.key);
    generationRef.current = Math.max(
        generationRef.current,
        input.state.operationGeneration,
    );
    contextKeyRef.current = input.context?.key;

    useEffect(() => {
        requestRef.current?.abort();
        requestRef.current = undefined;
        input.setState(previous => previous.activeOperation
            ? failMonitorOperation(
                previous,
                previous.activeOperation,
                new DOMException(
                    'Monitor operation interrupted by a control context change.',
                    'AbortError',
                ),
            )
            : previous);
        setCancelOpen(false);
        return () => {
            const pending = requestRef.current;
            pending?.abort();
            if (requestRef.current === pending) requestRef.current = undefined;
        };
    }, [input.connection.execution, input.context?.key, input.setState]);
    useEffect(() => {
        if (!input.policy.cancel.enabled &&
            input.state.activeOperation?.action !== 'cancel'
        ) {
            setCancelOpen(false);
        }
    }, [input.policy.cancel.enabled, input.state.activeOperation?.action]);

    const perform = useCallback(async (
        action: MonitorOperationAuthority['action'],
        operation: (
            signal: AbortSignal,
            authority: MonitorOperationAuthority,
        ) => Promise<void>,
        refreshAfter = false,
    ): Promise<boolean> => {
        const context = input.context;
        if (!context || requestRef.current) return false;
        const controller = new AbortController();
        requestRef.current = controller;
        const generation = ++generationRef.current;
        const started = beginMonitorOperation(
            input.state,
            context.key,
            action,
            generation,
        );
        const authority = started.authority;
        input.setState(previous => beginMonitorOperation(
            previous,
            context.key,
            action,
            authority.generation,
        ).state);
        let succeeded = false;
        try {
            await operation(controller.signal, authority);
            succeeded = true;
        } catch (error) {
            if (!controller.signal.aborted &&
                contextKeyRef.current === context.key
            ) {
                input.setState(previous => failMonitorOperation(
                    previous,
                    authority,
                    error,
                ));
            }
        } finally {
            if (refreshAfter && !controller.signal.aborted &&
                contextKeyRef.current === context.key
            ) {
                await input.connection.refreshAfterCurrent();
            }
            if (succeeded && !controller.signal.aborted &&
                contextKeyRef.current === context.key
            ) {
                input.setState(previous => completeMonitorOperation(
                    previous,
                    authority,
                ));
            }
            if (requestRef.current === controller) {
                requestRef.current = undefined;
            }
        }
        return succeeded;
    }, [
        input.connection.refreshAfterCurrent,
        input.context,
        input.setState,
        input.state,
    ]);

    const loadArtifact = useCallback(async (): Promise<void> => {
        if (!input.policy['load-artifact'].enabled || !input.run) return;
        await perform('load-artifact', async (signal, authority) => {
            const artifact = await requiredExecution(input.connection)
                .exportRunArtifact({
                    distributedRunId: input.run!.distributedRunId,
                    signal,
                });
            assertCurrentOperation(
                signal,
                contextKeyRef,
                authority.contextKey,
            );
            assertArtifactIdentity(artifact.distributedRunId, input.run!);
            input.setState(previous => completeMonitorArtifactOperation(
                previous,
                authority,
                artifact,
            ));
        });
    }, [
        input.connection,
        input.policy,
        input.run,
        input.setState,
        perform,
    ]);

    const exportArtifact = useCallback(async (): Promise<void> => {
        if (!input.policy['export-artifact'].enabled || !input.run) return;
        await perform('export-artifact', async (signal, authority) => {
            const artifact = await requiredExecution(input.connection)
                .exportRunArtifact({
                    distributedRunId: input.run!.distributedRunId,
                    signal,
                });
            assertCurrentOperation(
                signal,
                contextKeyRef,
                authority.contextKey,
            );
            assertArtifactIdentity(artifact.distributedRunId, input.run!);
            downloadDistributedRunArtifact(
                artifact,
                input.run!.distributedRunId,
            );
            input.setState(previous => completeMonitorArtifactOperation(
                previous,
                authority,
                artifact,
            ));
        });
    }, [input.connection, input.policy, input.run, input.setState, perform]);

    const confirmCancel = useCallback(async (): Promise<void> => {
        if (!input.policy.cancel.enabled || !input.run) return;
        const succeeded = await perform('cancel', async (signal, authority) => {
            const run = await requiredExecution(input.connection).cancelRun({
                distributedRunId: input.run!.distributedRunId,
                reason: 'Cancelled by Recipe Console Monitor operator.',
                signal,
            });
            assertCurrentOperation(
                signal,
                contextKeyRef,
                authority.contextKey,
            );
            assertRunIdentity(run, input.run!);
            assertCancelResponse(run, input.run!);
            input.setState(previous => projectMonitorMutation(
                previous,
                authority.contextKey,
                run,
            ));
        }, true);
        if (succeeded) setCancelOpen(false);
    }, [input.connection, input.policy.cancel.enabled, input.run, input.setState, perform]);

    return {
        cancelOpen,
        busyAction: input.state.activeOperation?.action,
        operationError: input.state.operationError === undefined
            ? undefined
            : projectControlOperationError(input.state.operationError),
        refresh: input.connection.refresh,
        loadArtifact,
        exportArtifact,
        requestCancel: () => {
            if (input.policy.cancel.enabled) setCancelOpen(true);
        },
        closeCancel: () => setCancelOpen(false),
        confirmCancel,
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
    contextRef: Readonly<{ current: string | undefined }>,
    expectedContextKey: string,
): void {
    if (signal.aborted) {
        throw new DOMException('Monitor action aborted.', 'AbortError');
    }
    if (!expectedContextKey || contextRef.current !== expectedContextKey) {
        throw new Error('Monitor context changed while the action was in progress.');
    }
}

function assertRunIdentity(
    value: ControlDistributedRunSnapshot,
    expected: ControlDistributedRunSnapshot,
): void {
    if (value.distributedRunId !== expected.distributedRunId ||
        value.controlRunId !== expected.controlRunId
    ) {
        throw new Error(
            'Control response identity does not match the requested Monitor run.',
        );
    }
}

function assertCancelResponse(
    value: ControlDistributedRunSnapshot,
    expected: ControlDistributedRunSnapshot,
): void {
    if (value.updatedAtEpochMs < expected.updatedAtEpochMs) {
        throw new Error('Cancel response is older than current Monitor truth.');
    }
    if (value.state !== 'cancelled') {
        throw new Error(
            `Cancel returned authoritative state ${value.state} instead of cancelled.`,
        );
    }
}

function assertArtifactIdentity(
    distributedRunId: string,
    expected: ControlDistributedRunSnapshot,
): void {
    if (distributedRunId !== expected.distributedRunId) {
        throw new Error(
            'Artifact response belongs to a different distributed run.',
        );
    }
}
