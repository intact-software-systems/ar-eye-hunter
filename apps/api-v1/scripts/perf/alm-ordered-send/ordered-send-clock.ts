/**
 * The one clock of a run: the run, its instances and its stand-ins all read time and wait through it, so a test
 * moves all of them with one fake.
 */
export interface OrderedSendClock {
    /** An unrounded reading of the monotonic clock every instant a run records is on, in milliseconds. */
    readonly nowMs: () => number;
    /** The epoch time an envelope, a connect or a notice carries, in milliseconds. */
    readonly nowEpochMs: () => number;
    /** Settles once `delayMs` have passed, or a little earlier or later, as a timer does. */
    readonly sleep: (delayMs: number) => Promise<void>;
}

export function createDefaultOrderedSendClock(): OrderedSendClock {
    return {
        nowMs: () => performance.now(),
        nowEpochMs: () => Date.now(),
        sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
    };
}
