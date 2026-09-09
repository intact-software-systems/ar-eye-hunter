import type { RallarBlackBoxBrowserRallarRuntime } from '../browser-adapter.ts';

type RtcConnectReadinessBoundaryValue = Awaited<ReturnType<RallarBlackBoxBrowserRallarRuntime['health']>>;

export interface RtcConnectReadinessAbortScope {
    readonly signal: AbortSignal;
    timedOut(): boolean;
    cleanup(): void;
}

const READINESS_TIMEOUT_ERROR_NAME = 'RALLAR_BB_RTC_READINESS_TIMEOUT';
const ABORT_ERROR_NAME = 'RALLAR_BLACK_BOX_ABORTED';

export function toRtcConnectReadinessAbortError(reason: RtcConnectReadinessBoundaryValue): Error {
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

function toReadinessTimeoutError(): Error {
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
    if (ms <= 0) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
            if (timeout !== undefined) {
                clearTimeout(timeout);
                timeout = undefined;
            }
            signal.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(signal.reason);
        };

        if (signal.aborted) {
            abort();
            return;
        }
        timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
}

export function createRtcConnectReadinessAbortScope(
    timeoutMs: number,
    parentSignal?: AbortSignal
): RtcConnectReadinessAbortScope {
    const controller = new AbortController();
    let deadlineReached = false;
    const abortFromParent = () => {
        if (!controller.signal.aborted) {
            controller.abort(toRtcConnectReadinessAbortError(parentSignal?.reason));
        }
    };
    const timeout = setTimeout(
        () => {
            deadlineReached = true;
            if (!controller.signal.aborted) {
                controller.abort(toReadinessTimeoutError());
            }
        },
        Math.max(0, timeoutMs)
    );

    if (parentSignal?.aborted) {
        abortFromParent();
    }
    else {
        parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    }

    return {
        signal: controller.signal,
        timedOut: () => deadlineReached,
        cleanup: () => {
            clearTimeout(timeout);
            parentSignal?.removeEventListener('abort', abortFromParent);
        }
    };
}
