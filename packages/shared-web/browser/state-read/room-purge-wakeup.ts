import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';

/** A storage cutoff wakes an authorized read. Only the server decides whether the room remains accessible. */
export class RoomPurgeWakeup {
    #cutoff: number | null = null;
    #cancel: (() => void) | undefined;
    readonly #readEarliestEpochMs: () => number | undefined;
    readonly #wake: () => void;

    constructor(readEarliestEpochMs: () => number | undefined, wake: () => void) {
        this.#readEarliestEpochMs = readEarliestEpochMs;
        this.#wake = wake;
    }

    observe(cutoff: number | null): void {
        if (cutoff === this.#cutoff) return;
        this.#cancel?.();
        this.#cutoff = cutoff;
        if (cutoff === null) return;
        // Losing calibration retires the socket. Its recovery will read the room and arm a fresh deadline.
        if (this.#readEarliestEpochMs() === undefined) {
            this.#cutoff = null;
            return;
        }
        const timers = { ...createDefaultTimers(), nowMs: () => this.#readEarliestEpochMs() ?? cutoff };
        const check = () => {
            if (timers.nowMs() < cutoff) arm();
            else this.#wake();
        };
        const arm = () => { this.#cancel = scheduleAtDeadline(timers, cutoff, check); };
        arm();
    }
}
