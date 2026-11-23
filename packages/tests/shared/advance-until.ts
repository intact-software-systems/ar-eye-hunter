import { vi } from 'vitest';

/** The real `setTimeout`, read before a suite installs its fake timers. */
const REAL_SET_TIMEOUT = globalThis.setTimeout;

/** One drain cycle per event-loop turn: enough for every hop's lock grants under a loaded runner. */
const DRAIN_MAX_CYCLES = 200;

/**
 * Runs the due fake timers until `condition` holds or the cycle budget runs out. Each cycle runs the due fake timers
 * without moving the clock and yields one real event-loop turn, which a Web Locks grant needs. It never throws: the
 * caller's assertion states what did not happen.
 */
export async function drainUntil(condition: () => boolean | Promise<boolean>, maxCycles = DRAIN_MAX_CYCLES): Promise<void> {
    for (let cycle = 0; cycle < maxCycles && !(await condition()); cycle++) {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise<void>((resolve) => REAL_SET_TIMEOUT(resolve, 0));
    }
}

/**
 * Moves fake time on in `stepMs` steps until `condition` holds, draining real event-loop turns after each step, so work
 * that waits on real asynchronous APIs (WebCrypto signs and verifies) completes as fake time passes. It never throws:
 * the caller's assertion states what did not happen.
 */
export async function advanceUntil(
    condition: () => boolean | Promise<boolean>,
    stepMs = 100,
    maxSteps = 20
): Promise<void> {
    for (let step = 0; step < maxSteps && !(await condition()); step++) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await drainUntil(condition, 20);
    }
}
