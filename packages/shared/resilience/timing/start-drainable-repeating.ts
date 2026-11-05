import type { FailureBackoff } from '../failure-backoff.ts';
import { toError } from '../to-error.ts';
import { startRepeating, type StartRepeating } from './start-repeating.ts';

export namespace StartDrainableRepeating {
    export interface Input extends Omit<StartRepeating.Input, 'retryBackoff' | 'run'> {
        readonly retryBackoff: FailureBackoff.Config;
        /** The signal aborts at stop, so a run in flight may end early. */
        readonly run: (stopping: AbortSignal) => Promise<void>;
        readonly onFailure: (error: Error) => void;
    }
}

/**
 * A repeating run whose stop resolves only after the run in flight settles. Each failure reaches `onFailure` once and
 * delays the next run by the retry backoff; stopping never reports the drained run's failure again.
 */
export function startDrainableRepeating(input: StartDrainableRepeating.Input): () => Promise<void> {
    const stopping = new AbortController();
    let pending: Promise<void> = Promise.resolve();
    const stopRepeating = startRepeating({
        timers: input.timers,
        intervalMs: input.intervalMs,
        firstRun: input.firstRun,
        retryBackoff: input.retryBackoff,
        run: () => {
            pending = input.run(stopping.signal).catch((error) => {
                const failure = toError(error);
                input.onFailure(failure);
                throw failure;
            });
            return pending;
        }
    });
    return async () => {
        stopping.abort();
        stopRepeating();
        await pending.catch(() => undefined);
    };
}
