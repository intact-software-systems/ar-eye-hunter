import type { Timers } from './timers.ts';
import { toError } from './to-error.ts';

export namespace ThrottledFlush {
    export interface Dependencies {
        readonly timers: Timers;
        /** The one write; it covers every mark made before it started. */
        readonly write: () => Promise<void>;
    }

    export interface Config {
        /** The least time between two writes' starts; an urgent mark writes at once. */
        readonly minIntervalMs: number;
    }
}

interface PendingWrite {
    /** Settles with the write that covers the marks made since the previous write started. */
    readonly completed: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
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

/**
 * Throttles marks into writes with a leading and a trailing edge: a mark made
 * while no write is in flight writes at once when `minIntervalMs` has passed
 * since the last write began, and otherwise schedules the write for that
 * write's start plus `minIntervalMs`; later marks join the scheduled write. A
 * mark made while a write is in flight schedules the next one the same way.
 * An urgent mark writes at once. One write is in flight at a time, and the
 * timer that starts a write settles with it. `stop()` drains: a scheduled
 * write runs at once, a write in flight is joined, and every mark made before
 * the drain ends gets its write.
 */
export class ThrottledFlush {
    private readonly dependencies: ThrottledFlush.Dependencies;
    private readonly config: ThrottledFlush.Config;
    private pending: PendingWrite | undefined;
    /** The write in flight; it settles the marks it covers and never rejects. */
    private writing: Promise<void> | undefined;
    private lastWriteStartedAtMs = Number.NEGATIVE_INFINITY;
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
            this.pending = createPendingWrite(urgent);
            if (this.writing === undefined) {
                this.armTimer(this.pending);
            }
        }
        else if (urgent && !this.pending.urgent) {
            this.pending.urgent = true;
            if (this.writing === undefined) {
                this.pending.cancelTimer?.();
                this.armTimer(this.pending);
            }
        }
        return this.pending.completed;
    }

    async stop(): Promise<void> {
        this.stopping = true;
        while (this.writing !== undefined || this.pending !== undefined) {
            if (this.writing === undefined) {
                this.pending?.cancelTimer?.();
                this.startWrite();
            }
            await this.writing;
        }
        this.stopped = true;
    }

    private armTimer(pending: PendingWrite): void {
        pending.cancelTimer = this.dependencies.timers.schedule(() => this.startWrite(), this.toWriteDelayMs(pending));
    }

    private toWriteDelayMs(pending: PendingWrite): number {
        if (pending.urgent) {
            return 0;
        }
        const sinceLastWriteMs = this.dependencies.timers.nowMs() - this.lastWriteStartedAtMs;
        return Math.max(0, this.config.minIntervalMs - sinceLastWriteMs);
    }

    private startWrite(): Promise<void> {
        const pending = this.pending;
        if (pending === undefined) {
            return Promise.resolve();
        }
        this.pending = undefined;
        pending.cancelTimer = undefined;
        this.lastWriteStartedAtMs = this.dependencies.timers.nowMs();
        const writing = startWriteCovering(this.dependencies.write, pending).then(() => this.completeWrite());
        this.writing = writing;
        return writing;
    }

    private completeWrite(): void {
        this.writing = undefined;
        if (this.pending !== undefined && !this.stopping) {
            this.armTimer(this.pending);
        }
    }
}

function toRefusedMark(): Promise<void> {
    const refused = Promise.reject(new ThrottledFlushStoppedError());
    refused.catch(() => {});
    return refused;
}

function createPendingWrite(urgent: boolean): PendingWrite {
    let resolve: () => void = () => {};
    let reject: (error: Error) => void = () => {};
    const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
        resolve = resolveCompleted;
        reject = rejectCompleted;
    });
    // A mark nobody awaits must not raise an unhandled rejection; awaiting marks still see the failure.
    completed.catch(() => {});
    return { completed, resolve, reject, urgent, cancelTimer: undefined };
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
