import type { ControlTimers } from '../../src/control-timers.ts';

export interface ManualControlTimers extends ControlTimers {
    /** Moves the clock to `epochMs`, running and awaiting every timer that falls due on the way, earliest first. */
    advanceTo(epochMs: number): Promise<void>;
}

interface ManualTimer {
    readonly dueEpochMs: number;
    readonly sequence: number;
    readonly run: () => Promise<void>;
}

export function createManualControlTimers(startEpochMs: number): ManualControlTimers {
    let nowEpochMs = startEpochMs;
    let sequence = 0;
    const pending = new Set<ManualTimer>();
    const nextDue = (untilEpochMs: number): ManualTimer | undefined =>
        [...pending]
            .filter((timer) => timer.dueEpochMs <= untilEpochMs)
            .sort((left, right) => left.dueEpochMs - right.dueEpochMs || left.sequence - right.sequence)[0];
    return {
        nowEpochMs: () => nowEpochMs,
        schedule: (run, delayMs) => {
            const timer = { dueEpochMs: nowEpochMs + Math.max(0, delayMs), sequence: sequence += 1, run };
            pending.add(timer);
            return () => pending.delete(timer);
        },
        advanceTo: async (epochMs) => {
            for (let timer = nextDue(epochMs); timer !== undefined; timer = nextDue(epochMs)) {
                pending.delete(timer);
                nowEpochMs = Math.max(nowEpochMs, timer.dueEpochMs);
                await timer.run();
            }
            nowEpochMs = Math.max(nowEpochMs, epochMs);
        }
    };
}
