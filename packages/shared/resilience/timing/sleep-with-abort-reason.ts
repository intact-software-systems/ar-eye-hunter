export function sleepWithAbortReason<Reason>(
    ms: number,
    signal: AbortSignal | undefined,
    toAbortReason: (signal: AbortSignal) => Reason
): Promise<void> {
    // A non-positive wait resolves even when the signal is already aborted.
    if (ms <= 0) {
        return Promise.resolve();
    }
    if (signal?.aborted) {
        return Promise.reject(toAbortReason(signal));
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        function abort(): void {
            clearTimeout(timeout);
            if (signal !== undefined) {
                reject(toAbortReason(signal));
            }
        }
        signal?.addEventListener('abort', abort, { once: true });
    });
}
