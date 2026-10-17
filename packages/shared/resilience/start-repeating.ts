import { FailureBackoff } from './failure-backoff.ts';
import type { Timers } from './timers.ts';
import { toError } from './to-error.ts';

export namespace StartRepeating {
    export interface Input {
        readonly timers: Timers;
        /** Measured from the end of one run to the start of the next. */
        readonly intervalMs: number;
        /**
         * The wait after a failed run; absent, a failed run waits the interval and its failure reaches the timer host
         * (a synchronous failure as a thrown error; an asynchronous one is unobserved by the default timers).
         */
        readonly retryBackoff?: FailureBackoff.Config;
        /** `now` runs within the start call; `after-interval` waits one interval first. */
        readonly firstRun: 'now' | 'after-interval';
        readonly run: () => void | Promise<void>;
    }
}

interface RepeatingRunFailure {
    readonly error: Error;
}

/**
 * Runs `run` again and again with the interval between runs, one run at a time; answers the stop, which is
 * idempotent and cancels the pending run. A run in flight at stop completes but is awaited by nothing and
 * schedules no successor. Without a retry backoff, a synchronous failure of a `now` first run ends the loop and
 * reaches the caller.
 */
export function startRepeating(input: StartRepeating.Input): () => void {
    if (!Number.isFinite(input.intervalMs) || input.intervalMs <= 0) {
        throw new TypeError('Repeating run requires a positive finite interval');
    }
    const retryBackoff = input.retryBackoff === undefined ? undefined : new FailureBackoff(input.retryBackoff);
    let stopped = false;
    let cancelPending: (() => void) | undefined;

    const scheduleNext = (delayMs: number): void => {
        if (!stopped) {
            cancelPending = input.timers.schedule(runOnce, delayMs);
        }
    };
    const settle = (failure: RepeatingRunFailure | undefined): void => {
        if (failure === undefined) {
            retryBackoff?.recordSuccess();
            scheduleNext(input.intervalMs);
            return;
        }
        if (retryBackoff === undefined) {
            scheduleNext(input.intervalMs);
            throw failure.error;
        }
        const nowMs = input.timers.nowMs();
        scheduleNext(retryBackoff.recordFailure(nowMs) - nowMs);
    };
    const runOnce = (): void | Promise<void> => {
        cancelPending = undefined;
        let outcome: void | Promise<void>;
        try {
            outcome = input.run();
        }
        catch (error) {
            return settle({ error: toError(error) });
        }
        if (outcome instanceof Promise) {
            return outcome.then(() => settle(undefined), (error) => settle({ error: toError(error) }));
        }
        return settle(undefined);
    };
    const stop = (): void => {
        stopped = true;
        cancelPending?.();
        cancelPending = undefined;
    };

    if (input.firstRun === 'now') {
        try {
            void runOnce();
        }
        catch (error) {
            stop();
            throw error;
        }
    }
    else {
        scheduleNext(input.intervalMs);
    }
    return stop;
}
