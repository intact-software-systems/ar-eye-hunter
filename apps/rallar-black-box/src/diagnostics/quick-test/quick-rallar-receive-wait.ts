import { createDirectRallarRuntimeEvent } from '../../direct-rallar-operations.ts';
import { rallarBlackBoxRuntimeStore } from '../../runtime-store.ts';
import type { DirectRallarOperationContext } from '../direct-rallar-contracts.ts';
import type { QuickRallarTestRuntimeState } from './use-quick-rallar-test-state.ts';

export interface QuickRallarReceiveWaitInput {
    readonly operationContext: DirectRallarOperationContext;
    readonly timeoutMs: number;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

export function waitForQuickRallarReceive({
    operationContext,
    timeoutMs,
    runtimeState
}: QuickRallarReceiveWaitInput): Promise<void> {
    const startCount = runtimeState.receivedCountRef.current;
    const startedAtEpochMs = Date.now();
    runtimeState.setWaitStatus('waiting');
    runtimeState.setBusyAction('Wait for receive');
    runtimeState.setLocalError(undefined);
    return waitForQuickRallarMessage(runtimeState, startCount, timeoutMs).then(
        () => recordQuickRallarReceive(operationContext, startedAtEpochMs, runtimeState),
        () => recordQuickRallarReceiveTimeout({ operationContext, startedAtEpochMs, runtimeState })
    ).finally(() => runtimeState.setBusyAction(undefined));
}

function waitForQuickRallarMessage(
    runtimeState: QuickRallarTestRuntimeState,
    startCount: number,
    timeoutMs: number
): Promise<void> {
    const startedAtEpochMs = Date.now();
    return new Promise((resolve, reject) => {
        const interval = window.setInterval(() => {
            if (runtimeState.receivedCountRef.current > startCount) {
                window.clearInterval(interval);
                resolve();
                return;
            }
            if (Date.now() - startedAtEpochMs > timeoutMs) {
                window.clearInterval(interval);
                reject(new Error('Timed out waiting for a Quick Test WebSocket receive.'));
            }
        }, 100);
    });
}

function recordQuickRallarReceive(
    operationContext: DirectRallarOperationContext,
    startedAtEpochMs: number,
    runtimeState: QuickRallarTestRuntimeState
): void {
    runtimeState.setWaitStatus('message observed');
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            topic: 'rallar.direct.quick.receive.completed',
            context: operationContext,
            transport: 'ws',
            payload: {
                waitedMs: Date.now() - startedAtEpochMs,
                receivedCount: runtimeState.receivedCountRef.current
            }
        }),
        'Quick Test receive observed'
    );
}

interface RecordQuickRallarReceiveTimeoutInput {
    readonly operationContext: DirectRallarOperationContext;
    readonly startedAtEpochMs: number;
    readonly runtimeState: QuickRallarTestRuntimeState;
}

function recordQuickRallarReceiveTimeout({
    operationContext,
    startedAtEpochMs,
    runtimeState
}: RecordQuickRallarReceiveTimeoutInput): void {
    const message = 'Timed out waiting for a Quick Test WebSocket receive.';
    runtimeState.setWaitStatus('timeout');
    runtimeState.setLocalError(message);
    rallarBlackBoxRuntimeStore.recordRuntimeEvent(
        createDirectRallarRuntimeEvent({
            topic: 'rallar.direct.quick.receive.timeout',
            context: operationContext,
            transport: 'ws',
            severity: 'error',
            payload: {
                waitedMs: Date.now() - startedAtEpochMs,
                receivedCount: runtimeState.receivedCountRef.current,
                error: message
            }
        }),
        'Quick Test receive timed out'
    );
}
