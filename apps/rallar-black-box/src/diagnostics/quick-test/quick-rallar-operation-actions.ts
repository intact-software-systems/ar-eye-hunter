import { createDirectRallarRuntimeEvent, type DirectRallarOperationResult } from '../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface RecordQuickRallarOperationResultInput {
    readonly result: DirectRallarOperationResult;
    readonly completedAction: string;
    readonly failedAction: string;
    readonly operationContext: DirectRallarOperationContext;
    readonly activeTypeId: string;
    readonly activeTopicId: string;
    readonly activeContextId: string;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

export interface RunQuickRallarOperationInput<T extends DirectRallarOperationResult>
    extends Omit<RecordQuickRallarOperationResultInput, 'result'> {
    readonly busyLabel: string;
    action(): Promise<T>;
    onCompleted?(result: T): void;
}

export function recordQuickRallarOperationResult({
    result,
    completedAction,
    failedAction,
    operationContext,
    activeTypeId,
    activeTopicId,
    activeContextId,
    runtimeState
}: RecordQuickRallarOperationResultInput): void {
    for (const event of result.events) {
        rallarBlackBoxRuntimeStore.recordRuntimeEvent(event);
    }
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            kind: 'state',
            topic: `rallar.direct.quick.${result.kind}.${result.status}`,
            context: operationContext,
            transport: result.kind.startsWith('ws.') ? 'ws' : undefined,
            severity: result.status === 'failed' ? 'error' : 'info',
            payload: {
                status: result.status,
                durationMs: result.durationMs,
                groupId: operationContext.roomId,
                selector: { typeId: activeTypeId, topicId: activeTopicId, contextId: activeContextId },
                error: result.error
            }
        }),
        result.status === 'failed' ? failedAction : completedAction
    );
    runtimeState.setLastResult(result);
    if (result.status === 'failed') {
        runtimeState.setLocalError(result.error?.message ?? failedAction);
    }
}

export async function runQuickRallarOperation<T extends DirectRallarOperationResult>({
    busyLabel,
    action,
    onCompleted,
    runtimeState,
    ...resultInput
}: RunQuickRallarOperationInput<T>): Promise<void> {
    runtimeState.setBusyAction(busyLabel);
    runtimeState.setLocalError(undefined);
    try {
        const result = await action();
        recordQuickRallarOperationResult({ ...resultInput, result, runtimeState });
        if (result.status === 'completed') {
            onCompleted?.(result);
        }
    }
    catch (error) {
        runtimeState.setLocalError(error instanceof Error ? error.message : String(error));
    }
    finally {
        runtimeState.setBusyAction(undefined);
    }
}
