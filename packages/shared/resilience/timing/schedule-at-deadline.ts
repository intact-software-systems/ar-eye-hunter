import type { Timers } from '../timers.ts';

/** Native timers hold a signed 32-bit delay; a longer one would fire at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Runs `run` once when the clock reaches `deadlineAtMs`, re-arming in bounded steps for far deadlines. */
export function scheduleAtDeadline(
    timers: Timers,
    deadlineAtMs: number,
    run: () => void | Promise<void>
): () => void {
    let cancel: () => void = () => {};
    const arm = (): void => {
        const remainingMs = Math.max(0, deadlineAtMs - timers.nowMs());
        cancel = timers.schedule(
            remainingMs > MAX_TIMER_DELAY_MS ? arm : run,
            Math.min(remainingMs, MAX_TIMER_DELAY_MS)
        );
    };
    arm();
    return () => cancel();
}
