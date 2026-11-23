import { toExponentialBackoffMs } from '@shared/resilience/ComputeAsyncTask.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { scheduleAtDeadline } from '@shared/resilience/timing/schedule-at-deadline.ts';

/** A storage cutoff wakes an authorized read. Only the server decides whether the room remains accessible. */
export class RoomPurgeWakeup {
    #cutoff: number | null = null;
    #confirmations = 0;
    #cancel: (() => void) | undefined;
    readonly #readEarliestEpochMs: () => number | undefined;
    readonly #wake: () => void;

    constructor(readEarliestEpochMs: () => number | undefined, wake: () => void) {
        this.#readEarliestEpochMs = readEarliestEpochMs;
        this.#wake = wake;
    }

    observe(cutoff: number | null): void {
        if (cutoff !== this.#cutoff) {
            this.#cancel?.();
            this.#cancel = undefined;
            this.#confirmations = 0;
            this.#cutoff = cutoff;
        }
        if (cutoff === null || this.#cancel) return;
        const now = this.#readEarliestEpochMs();
        if (now === undefined) return;
        // A successful read after the wake can mean the storage node is behind the clock node.
        const deadline = this.#confirmations === 0 ? cutoff : now + toExponentialBackoffMs(this.#confirmations, 30_000, 1_000);
        const timers = { ...createDefaultTimers(), nowMs: () => this.#readEarliestEpochMs() ?? deadline };
        const arm = () => { this.#cancel = scheduleAtDeadline(timers, deadline, check); };
        const check = () => {
            if (timers.nowMs() < deadline) {
                arm();
                return;
            }
            this.#cancel = undefined;
            this.#confirmations++;
            this.#wake();
        };
        arm();
    }
}
