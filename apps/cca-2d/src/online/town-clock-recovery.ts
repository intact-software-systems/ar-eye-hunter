import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import type { RallarFacade } from '@shared-web/browser/rallar.ts';
import { sleepWithAbortReason } from '@shared/resilience/timing/sleep-with-abort-reason.ts';
import { toError } from '@shared/resilience/to-error.ts';

/** A retired clock requires a new SDK connection before the server can confirm the same seat. */
export function watchTownClockLoss(
    browser: { readonly ws: Pick<RallarFacade['ws'], 'onLifecycle'> },
    lifetime: AbortSignal,
    restore: (signal: AbortSignal) => Promise<void>,
    failed: (error: Error) => void
): () => void {
    let pending: AbortController | undefined;
    const cancel = () => {
        pending?.abort();
        pending = undefined;
    };
    const stop = browser.ws.onLifecycle(event => {
        if (event.kind !== 'disconnected' || !event.reason?.startsWith('server-clock-ended:') || pending || lifetime.aborted) return;
        const attempt = new AbortController();
        pending = attempt;
        void recover(attempt);
    }, { emitCurrent: false });
    lifetime.addEventListener('abort', () => { stop(); cancel(); }, { once: true });
    return cancel;

    async function recover(attempt: AbortController): Promise<void> {
        try {
            // Finish retiring the old middleware before reconnecting.
            for (const delay of [0, 500, 1000, 2000, 4000, 8000]) {
                await sleepWithAbortReason(delay, attempt.signal, signal => signal.reason);
                if (document.hidden || !navigator.onLine) await waitForReachableTown(attempt.signal);
                attempt.signal.throwIfAborted();
                try {
                    await restore(attempt.signal);
                    return;
                }
                catch (error) {
                    if (delay === 8000 || error instanceof ApiHttpError && [401, 403, 404].includes(error.status)) throw error;
                }
            }
        }
        catch (error) {
            if (!attempt.signal.aborted) failed(toError(error));
        }
        finally {
            if (pending === attempt) pending = undefined;
        }
    }
}

async function waitForReachableTown(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const available = Promise.withResolvers<void>();
    const check = () => {
        if (!document.hidden && navigator.onLine) available.resolve();
    };
    const abort = () => available.reject(signal.reason);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    signal.addEventListener('abort', abort, { once: true });
    try {
        await available.promise;
    }
    finally {
        document.removeEventListener('visibilitychange', check);
        window.removeEventListener('online', check);
        signal.removeEventListener('abort', abort);
    }
}
