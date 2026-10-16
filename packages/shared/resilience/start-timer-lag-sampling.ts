import { startRepeating } from './start-repeating.ts';
import type { Timers } from './timers.ts';

export namespace StartTimerLagSampling {
    export interface Input {
        readonly timers: Timers;
        /** The fixed tick whose lateness is sampled. */
        readonly tickIntervalMs: number;
        /** A window closes on the first tick at or after this long since it opened. */
        readonly windowMs: number;
        readonly onWindow: (window: TimerLagWindow) => void;
    }
}

/** How late the ticks of one window fired, in milliseconds past each tick's due time. */
export interface TimerLagWindow {
    readonly startedAtMs: number;
    readonly endedAtMs: number;
    readonly sampleCount: number;
    readonly maxLagMs: number;
    readonly p50LagMs: number;
}

/**
 * Ticks on a fixed interval and reports, once per window, how late the ticks fired: a busy event loop runs every
 * timer late, so the lag is its occupancy. Answers the stop; an unfinished window is not reported.
 */
export function startTimerLagSampling(input: StartTimerLagSampling.Input): () => void {
    const { timers, tickIntervalMs } = input;
    let windowStartedAtMs = timers.nowMs();
    let dueAtMs = windowStartedAtMs + tickIntervalMs;
    let lagsMs: number[] = [];

    return startRepeating({
        timers,
        intervalMs: tickIntervalMs,
        firstRun: 'after-interval',
        run: () => {
            const nowMs = timers.nowMs();
            lagsMs.push(Math.max(0, nowMs - dueAtMs));
            dueAtMs = nowMs + tickIntervalMs;
            if (nowMs - windowStartedAtMs < input.windowMs) {
                return;
            }
            input.onWindow(computeTimerLagWindow(windowStartedAtMs, nowMs, lagsMs));
            windowStartedAtMs = nowMs;
            lagsMs = [];
        }
    });
}

function computeTimerLagWindow(
    startedAtMs: number,
    endedAtMs: number,
    lagsMs: readonly number[]
): TimerLagWindow {
    const sorted = lagsMs.toSorted((left, right) => left - right);
    return {
        startedAtMs,
        endedAtMs,
        sampleCount: sorted.length,
        maxLagMs: sorted[sorted.length - 1] ?? 0,
        p50LagMs: sorted[Math.max(0, Math.ceil(sorted.length / 2) - 1)] ?? 0
    };
}
