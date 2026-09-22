const ABORT_ERROR_NAME = 'RALLAR_BLACK_BOX_ABORTED';

export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(decodeAbortError(signal.reason));
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        function abort(): void {
            clearTimeout(timeout);
            reject(decodeAbortError(signal?.reason));
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
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
