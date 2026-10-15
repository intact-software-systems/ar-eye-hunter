/** The control server's clock and one-shot timer: `schedule` runs `run` once after `delayMs` and answers its cancel. */
export interface ControlTimers {
    readonly nowEpochMs: () => number;
    readonly schedule: (run: () => void | Promise<void>, delayMs: number) => () => void;
}

export function createDefaultControlTimers(): ControlTimers {
    return {
        nowEpochMs: () => Date.now(),
        schedule: (run, delayMs) => {
            const timer = setTimeout(() => void run(), delayMs);
            return () => clearTimeout(timer);
        }
    };
}
