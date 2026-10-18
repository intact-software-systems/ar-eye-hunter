import type { Timers } from './timers.ts';
import { toError } from './to-error.ts';

interface PendingWrite {
    /** Settles with the write that covers the marks made since the previous write started. */
    readonly completed: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly firstMarkedAtMs: number;
    urgent: boolean;
    cancelTimer: (() => void) | undefined;
}

/** A mark after `stop()` resolved: the flush has drained and writes nothing more. */
export class ThrottledFlushStoppedError extends Error {
    constructor() {
        super('Throttled flush is stopped.');
        this.name = 'ThrottledFlushStoppedError';
    }
}

export namespace ThrottledFlush {
    export interface Dependencies {
        readonly timers: Timers;
        /** The one write; it covers every mark made before it started. */
        readonly write: () => Promise<void>;
    }

    export interface Config {
        /** The least time between two writes' starts; an urgent mark writes at once. */
        readonly minIntervalMs: number;
        /** Ordinary marks wait from the first mark in their group; later marks do not postpone it. */
        readonly firstMarkDelayMs: number;
    }
}

/**
 * Coalesces marks into one write at a time. Ordinary writes wait for both the
 * first mark's delay and the interval since the previous write started.
 * Urgent marks bypass those delays. Marks during a write stay pending without
 * timers until that write completes. A timer settles with the write it starts.
 * Draining runs pending work immediately, includes new marks until idle, and
 * leaves no timer. Only stop makes that drain terminal.
 */
export class ThrottledFlush {
    private readonly dependencies: ThrottledFlush.Dependencies;
    private readonly config: ThrottledFlush.Config;
    private pending: PendingWrite | undefined;
    /** The write in flight; it settles the marks it covers and never rejects. */
    private writing: Promise<void> | undefined;
    private lastWriteStartedAtMs = Number.NEGATIVE_INFINITY;
    private draining: Promise<void> | undefined;
    private stopping = false;
    private stopped = false;

    constructor(dependencies: ThrottledFlush.Dependencies, config: ThrottledFlush.Config) {
        this.dependencies = dependencies;
        this.config = config;
    }

    /**
     * Resolves once the write covering this mark completed; rejects with that
     * write's failure, or with `ThrottledFlushStoppedError` after `stop()`.
     */
    mark(urgent = false): Promise<void> {
        if (this.stopped) {
            return toRefusedMark();
        }
        if (this.pending === undefined) {
            this.pending = createPendingWrite(urgent, this.dependencies.timers.nowMs());
            if (this.writing === undefined && this.draining === undefined) {
                this.armTimer(this.pending);
            }
        }
        else if (urgent && !this.pending.urgent) {
            this.pending.urgent = true;
            if (this.writing === undefined && this.draining === undefined) {
                this.pending.cancelTimer?.();
                this.armTimer(this.pending);
            }
        }
        return this.pending.completed;
    }

    /** Joins the current drain, including marks made until idle, without closing later recording. */
    drain(): Promise<void> {
        if (this.draining !== undefined) {
            return this.draining;
        }
        if (this.writing === undefined && this.pending === undefined) {
            this.stopped = this.stopping;
            return Promise.resolve();
        }
        this.pending?.cancelTimer?.();
        this.draining = Promise.resolve().then(() => this.drainPending());
        return this.draining;
    }

    stop(): Promise<void> {
        this.stopping = true;
        return this.drain();
    }

    private async drainPending(): Promise<void> {
        while (this.writing !== undefined || this.pending !== undefined) {
            if (this.writing === undefined) {
                this.startWrite();
            }
            await this.writing;
        }
        this.draining = undefined;
        this.stopped = this.stopping;
    }

    private armTimer(pending: PendingWrite): void {
        pending.cancelTimer = this.dependencies.timers.schedule(() => this.startWrite(), this.toWriteDelayMs(pending));
    }

    private toWriteDelayMs(pending: PendingWrite): number {
        if (pending.urgent) {
            return 0;
        }
        const earliestStartMs = Math.max(
            pending.firstMarkedAtMs + this.config.firstMarkDelayMs,
            this.lastWriteStartedAtMs + this.config.minIntervalMs
        );
        return Math.max(0, earliestStartMs - this.dependencies.timers.nowMs());
    }

    private startWrite(): Promise<void> {
        const pending = this.pending;
        if (pending === undefined) {
            return Promise.resolve();
        }
        this.pending = undefined;
        pending.cancelTimer = undefined;
        this.lastWriteStartedAtMs = this.dependencies.timers.nowMs();
        const writing = Promise.resolve()
            .then(() => startWriteCovering(this.dependencies.write, pending))
            .then(() => this.completeWrite());
        this.writing = writing;
        return writing;
    }

    private completeWrite(): void {
        this.writing = undefined;
        if (this.pending !== undefined && this.draining === undefined) {
            this.armTimer(this.pending);
        }
    }
}

function toRefusedMark(): Promise<void> {
    const refused = Promise.reject(new ThrottledFlushStoppedError());
    refused.catch(() => {});
    return refused;
}

function createPendingWrite(urgent: boolean, firstMarkedAtMs: number): PendingWrite {
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
        resolve = resolveCompleted;
        reject = rejectCompleted;
    });
    // A mark nobody awaits must not raise an unhandled rejection; awaiting marks still see the failure.
    completed.catch(() => {});
    return { completed, resolve, reject, firstMarkedAtMs, urgent, cancelTimer: undefined };
}

async function startWriteCovering(write: () => Promise<void>, pending: PendingWrite): Promise<void> {
    try {
        await write();
        pending.resolve();
    }
    catch (error) {
        pending.reject(toError(error));
    }
}
