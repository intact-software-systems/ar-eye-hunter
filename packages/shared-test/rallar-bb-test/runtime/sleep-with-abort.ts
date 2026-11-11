import { sleepWithAbort as sleepWithAbortReason } from '@shared/resilience/timing/sleep-with-abort.ts';

const ABORT_ERROR_NAME = 'RALLAR_BLACK_BOX_ABORTED';

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWithAbortReason(ms, signal, (aborted) => decodeAbortError(aborted.reason));
}

export function isAbortError(error: unknown): error is Error {
    return error instanceof Error && error.name === ABORT_ERROR_NAME;
}

function decodeAbortError(reason: unknown): Error {
    if (reason instanceof Error) {
        return reason;
    }
    const error = new Error(
        typeof reason === 'string' && reason.length > 0 ? reason : 'Rallar black-box runtime operation was cancelled.'
    );
    error.name = ABORT_ERROR_NAME;
    return error;
}
