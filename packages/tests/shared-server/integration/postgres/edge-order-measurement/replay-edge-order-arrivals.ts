import { EdgeOrderReceiver, type EdgeOrderGap } from './edge-order-receiver.ts';
import type { EdgeOrderStamp } from './edge-order-sender.ts';

/** One recipient's first read of a room message. Times are epoch milliseconds, with a fraction. */
export interface EdgeOrderArrival {
    readonly publisher: string;
    /** The stamp as it was read from the payload that arrived. */
    readonly stamp: EdgeOrderStamp;
    readonly arrivedAtMs: number;
    readonly expiresAtMs: number;
}

/** An arrival the receiver handed to the application, and when. */
export interface EdgeOrderHandOver {
    readonly arrival: EdgeOrderArrival;
    readonly handedOverAtMs: number;
}

export interface EdgeOrderReplaySettings {
    readonly entryWaitMs: number;
    readonly maxHeldPerStream: number;
    readonly maxStreams: number;
}

/** What one recipient's application would have seen, had the receiver stood between the socket and it. */
export interface EdgeOrderReplay {
    /** In hand-over order. */
    readonly handOvers: readonly EdgeOrderHandOver[];
    readonly gaps: readonly EdgeOrderGap[];
    /** Arrivals dropped because the receiver had already passed their position. */
    readonly lateDrops: number;
    /** The most messages the receiver held at once, read after each arrival was accepted. */
    readonly mostHeld: number;
}

interface ReplayTimer {
    readonly atMs: number;
    readonly run: () => void;
    cancelled: boolean;
}

/**
 * Runs one recipient's arrivals, in arrival order, through the edge-order receiver on a clock that only the
 * arrivals and the receiver's own timers move. The replay is exact for the rule: the receiver reads no other clock.
 */
export function replayEdgeOrderArrivals(
    arrivals: readonly EdgeOrderArrival[],
    settings: EdgeOrderReplaySettings
): EdgeOrderReplay {
    let nowMs = 0;
    let lateDrops = 0;
    let mostHeld = 0;
    const timers: ReplayTimer[] = [];
    const handOvers: EdgeOrderHandOver[] = [];
    const gaps: EdgeOrderGap[] = [];
    const receiver = new EdgeOrderReceiver<EdgeOrderArrival, ReplayTimer>({
        ...settings,
        now: () => nowMs,
        setTimer: (run, delayMs) => {
            const timer: ReplayTimer = { atMs: nowMs + delayMs, run, cancelled: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer) => {
            timer.cancelled = true;
        },
        handOver: (arrival) => handOvers.push({ arrival, handedOverAtMs: nowMs }),
        onGap: (gap) => gaps.push(gap),
        onLate: () => {
            lateDrops += 1;
        }
    });
    const runTimersDueBy = (limitMs: number): void => {
        for (;;) {
            const due = timers.filter((timer) => !timer.cancelled && timer.atMs <= limitMs).sort((a, b) => a.atMs - b.atMs)[0];
            if (due === undefined) {
                return;
            }
            due.cancelled = true;
            nowMs = Math.max(nowMs, due.atMs);
            due.run();
        }
    };
    for (const arrival of arrivals) {
        runTimersDueBy(arrival.arrivedAtMs);
        nowMs = Math.max(nowMs, arrival.arrivedAtMs);
        receiver.accept(arrival.publisher, arrival.stamp, arrival.expiresAtMs, arrival);
        mostHeld = Math.max(mostHeld, receiver.getHeldCount());
    }
    runTimersDueBy(Number.POSITIVE_INFINITY);
    return { handOvers, gaps, lateDrops, mostHeld };
}
