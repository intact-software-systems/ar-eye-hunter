import type { Timers } from '@shared/resilience/timers.ts';

/** A clock and one-shot timer the test moves by hand; every timer due by the new time runs, earliest first. */
export interface ManualTimers extends Timers {
    /** Moves the clock to `atMs`, running and awaiting every timer that falls due on the way, earliest first. */
    advanceTo(atMs: number): Promise<void>;
    /** Moves the clock `byMs` ahead the same way. */
    advance(byMs: number): Promise<void>;
    pendingCount(): number;
}

interface ManualTimer {
    readonly dueMs: number;
    readonly sequence: number;
    readonly run: () => void | Promise<void>;
}

export function createManualTimers(startMs: number): ManualTimers {
    let nowMs = startMs;
    let sequence = 0;
    const pending = new Set<ManualTimer>();
    const nextDue = (untilMs: number): ManualTimer | undefined =>
        [...pending]
            .filter((timer) => timer.dueMs <= untilMs)
            .sort((left, right) => left.dueMs - right.dueMs || left.sequence - right.sequence)[0];
    const advanceTo = async (atMs: number): Promise<void> => {
        for (let timer = nextDue(atMs); timer !== undefined; timer = nextDue(atMs)) {
            pending.delete(timer);
            nowMs = Math.max(nowMs, timer.dueMs);
            await timer.run();
        }
        nowMs = Math.max(nowMs, atMs);
    };
    return {
        nowMs: () => nowMs,
        schedule: (run: () => void | Promise<void>, delayMs) => {
            const timer = { dueMs: nowMs + Math.max(0, delayMs), sequence: sequence += 1, run };
            pending.add(timer);
            return () => {
                pending.delete(timer);
            };
        },
        advanceTo,
        advance: (byMs) => advanceTo(nowMs + byMs),
        pendingCount: () => pending.size
    };
}
