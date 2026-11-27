/**
 * The clock a run reads and waits through, so a test moves what reads it with one fake. It covers: every instant a
 * run records; the epoch time of every envelope, ACK, connect and live notice the cell itself makes; every wait of
 * the cell's own, which are the due instants of the offers, the ACK offsets, the polls, the tail, the loop-lag timer
 * and the delay added to a database round trip; and everything a publisher's stand-in decides. It does not cover the
 * product's own clocks: the WS server service, its AL runtime stores and their expiry filters, the QueueBox and its
 * workers' timers read the wall clock themselves (`Date`, `Temporal.Now`), and PostgreSQL reads its own.
 */
export interface RoomSendClock {
    /** An unrounded reading of the monotonic clock every instant a run records is on, in milliseconds. */
    readonly nowMs: () => number;
    /** The epoch time an envelope, a connect or a notice carries, in milliseconds. */
    readonly nowEpochMs: () => number;
    /** Settles once `delayMs` have passed, or a little earlier or later, as a timer does. */
    readonly sleep: (delayMs: number) => Promise<void>;
}

export function createDefaultRoomSendClock(): RoomSendClock {
    return {
        nowMs: () => performance.now(),
        nowEpochMs: () => Date.now(),
        sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
    };
}
