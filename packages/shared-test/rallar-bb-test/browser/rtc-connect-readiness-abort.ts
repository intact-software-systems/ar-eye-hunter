import { DeadlineAbortScope } from '@shared/resilience/timing/deadline-abort-scope.ts';
import { sleepWithAbort } from '@shared/resilience/timing/sleep-with-abort.ts';

export interface RtcConnectReadinessAbortScope {
    readonly signal: AbortSignal;
    timedOut(): boolean;
    cleanup(): void;
}

const READINESS_TIMEOUT_ERROR_NAME = 'RALLAR_BB_RTC_READINESS_TIMEOUT';
const ABORT_ERROR_NAME = 'RALLAR_BLACK_BOX_ABORTED';

export function decodeRtcConnectReadinessAbortReason(reason: unknown): Error {
    if (reason instanceof Error && reason.name === ABORT_ERROR_NAME) {
        return reason;
    }

    const error = new Error(
        typeof reason === 'string' && reason.length > 0
            ? reason
            : reason instanceof Error
            ? reason.message
            : 'Rallar black-box RTC readiness was cancelled.'
    );
    error.name = ABORT_ERROR_NAME;
    return error;
}

/** A parent abort takes precedence over any timeout or operation failure racing it. */
export function toParentAbortError(parentSignal: AbortSignal | undefined): Error | undefined {
    return parentSignal?.aborted ? decodeRtcConnectReadinessAbortReason(parentSignal.reason) : undefined;
}

function createReadinessTimeoutError(): Error {
    const error = new Error('RTC connect readiness timeout reached.');
    error.name = READINESS_TIMEOUT_ERROR_NAME;
    return error;
}

export function raceWithRtcConnectReadinessAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const complete = (effect: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', abort);
            effect();
        };
        const abort = () => complete(() => reject(signal.reason));

        promise.then(
            (value) => complete(() => resolve(value)),
            (error) => complete(() => reject(error))
        );
        if (signal.aborted) {
            abort();
            return;
        }
        signal.addEventListener('abort', abort, { once: true });
    });
}

export function waitForRtcConnectReadinessPoll(ms: number, signal: AbortSignal): Promise<void> {
    return sleepWithAbort(ms, signal, (aborted) => aborted.reason);
}

export function createRtcConnectReadinessAbortScope(
    timeoutMs: number,
    parentSignal?: AbortSignal
): RtcConnectReadinessAbortScope {
    const scope = new DeadlineAbortScope({
        parentSignal,
        timeoutMs: Math.max(0, timeoutMs),
        toParentReason: (parent) => decodeRtcConnectReadinessAbortReason(parent.reason),
        toTimeoutReason: createReadinessTimeoutError
    });
    return {
        signal: scope.signal,
        timedOut: () => scope.deadlineReached(),
        cleanup: () => scope.cleanup()
    };
}
