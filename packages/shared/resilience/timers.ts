/**
 * A clock and a one-shot timer: `schedule` runs `run` once after `delayMs` and answers its cancel. The default
 * timers do not observe an asynchronous run: its rejection is unhandled, so a run that can fail asynchronously
 * owns its failure.
 */
export interface Timers {
    nowMs(): number;
    schedule(run: () => void | Promise<void>, delayMs: number): () => void;
}

export function createDefaultTimers(): Timers {
    return {
        nowMs: () => Date.now(),
        schedule: (run, delayMs) => {
            const handle = setTimeout(run, delayMs);
            return () => clearTimeout(handle);
        }
    };
}

/** The default timers whose pending timer does not hold a Node process open. */
export function createDefaultBackgroundTimers(): Timers {
    return {
        nowMs: () => Date.now(),
        schedule: (run, delayMs) => {
            const handle = setTimeout(run, delayMs);
            unrefTimerHandle(handle);
            return () => clearTimeout(handle);
        }
    };
}

function unrefTimerHandle(handle: number | object): void {
    if (typeof handle === 'object' && 'unref' in handle && typeof handle.unref === 'function') {
        handle.unref();
    }
}
