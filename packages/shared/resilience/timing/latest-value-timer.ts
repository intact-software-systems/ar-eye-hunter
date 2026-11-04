import type { Timers } from '../timers.ts';

export namespace LatestValueTimer {
    export type Emit<T> = (value: T) => void;
    export interface Pending<T> {
        value: T;
        emit: Emit<T>;
    }
}

/**
 * Replaces pending values without postponing their first deadline. Cancellation discards work;
 * emission clears the slot before invoking the latest emitter, which owns asynchronous completion or failure.
 */
export class LatestValueTimer<T> {
    private readonly timers: Timers;
    private pending: LatestValueTimer.Pending<T> | undefined;
    private cancelTimer: (() => void) | undefined;

    constructor(timers: Timers) {
        this.timers = timers;
    }

    getPending(): T | undefined {
        return this.pending?.value;
    }

    schedule(value: T, delayMs: number, emit: LatestValueTimer.Emit<T>): void {
        if (this.pending) {
            this.pending.value = value;
            this.pending.emit = emit;
            return;
        }
        const pending = { value, emit };
        this.pending = pending;
        this.cancelTimer = this.timers.schedule(() => this.emitPending(pending), delayMs);
    }

    cancel(): void {
        this.pending = undefined;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
    }

    private emitPending(pending: LatestValueTimer.Pending<T>): void {
        if (this.pending !== pending) {
            return;
        }
        this.pending = undefined;
        this.cancelTimer = undefined;
        pending.emit(pending.value);
    }
}
