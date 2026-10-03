import type { Unsubscribe } from '../../cache/RepositoryInterfaces.ts';
import { toError } from '../../resilience/to-error.ts';
import type { InMemoryAdmissionBackend } from '../al-admission-backend.ts';
import type { ALStorageHealth } from '../storage/al-storage-health.ts';
import { toALStorageFailure, type ALStorageUnavailable } from '../storage/al-storage-unavailable.ts';
import type { ALCheckpointDirtySet } from './al-checkpoint-dirty-set.ts';
import { computeALCheckpointMutations, type ALCheckpointMutations } from './compute-al-checkpoint-mutations.ts';

export namespace ALCheckpointWriter {
    export interface Settings {
        /** The target age of the oldest unsaved change: the first change arms one checkpoint this far ahead. */
        readonly intervalMs: number;
        /** Beyond this age the store reads `failing`, and new admissions follow `onStorageUnavailable`. */
        readonly lagBoundMs: number;
    }

    /** The one timer the checkpoint arms: `schedule` runs `run` once after `delayMs` and answers its cancel. */
    export interface Timers {
        readonly schedule: (run: () => void, delayMs: number) => () => void;
    }

    export interface Input {
        /** The memory pair whose dirty keys each checkpoint reads as they are held then. */
        readonly memory: Pick<InMemoryAdmissionBackend, 'peek' | 'workQueue'>;
        readonly dirty: ALCheckpointDirtySet;
        /** One readwrite transaction; it lands every mutation or none. */
        readonly write: (mutations: ALCheckpointMutations) => Promise<void>;
        readonly health: ALStorageHealth;
        readonly settings: Settings;
        readonly nowMs: () => number;
        /** Names each write once, so a restore can tell the rows of one checkpoint apart. */
        readonly newWriteToken: () => string;
        readonly timers: Timers;
    }
}

/**
 * Saves one memory pair's changed rows to IndexedDB; its checkpoint builds it only in the runtime that
 * owns its session's durable work. The oldest unsaved change arms one checkpoint an interval after it, so no later change
 * postpones it, and nothing runs while the pair is clean. One write is in flight at a time and changes
 * made during it reach the next one; a completed write clears only the keys still at the revision it
 * captured. The store reads `delayed` once a write failed or the oldest unsaved change is two intervals
 * old (a throttled timer), and `failing` with `checkpoint-lag` once it is past the lag bound; a
 * checkpoint that starts on time and completes reads `healthy` throughout. No lag check runs while a
 * write is in flight: its completion or failure is the next one (IndexedDB aborts a hung transaction).
 */
export class ALCheckpointWriter {
    private readonly input: ALCheckpointWriter.Input;
    private readonly subscription: Unsubscribe;
    /** Cancels the armed checkpoint; `undefined` while none is armed. */
    private cancelTimer: (() => void) | undefined;
    private inFlight: ALCheckpointDirtySet.Snapshot | undefined;
    private flushRequested = false;
    private retryNotBeforeMs = Number.NEGATIVE_INFINITY;
    private lastWriteFailure: ALStorageUnavailable | undefined;
    /** Past the bound the lag is stated once; a completed write ends it. */
    private lagStated = false;
    private disposed = false;

    constructor(input: ALCheckpointWriter.Input) {
        this.input = input;
        this.subscription = input.dirty.onMarkedDo(() => this.arm());
    }

    /** Starts a checkpoint now, or right after the one in flight; its caller never waits for it. */
    flush(): void {
        if (this.disposed) {
            return;
        }
        if (this.inFlight !== undefined) {
            this.flushRequested = true;
            return;
        }
        this.startWrite();
    }

    dispose(): void {
        this.disposed = true;
        this.disarm();
        this.subscription.unsubscribe();
    }

    private arm(): void {
        if (
            this.disposed || this.inFlight !== undefined || this.cancelTimer !== undefined
        ) {
            return;
        }
        const dueAtMs = this.computeDueAtMs();
        if (dueAtMs !== undefined) {
            this.cancelTimer = this.input.timers.schedule(() => this.fire(), Math.max(0, dueAtMs - this.input.nowMs()));
        }
    }

    private disarm(): void {
        this.cancelTimer?.();
        this.cancelTimer = undefined;
    }

    /**
     * The next checkpoint, an interval after the oldest unsaved change, or after a failed write's retry
     * delay; earlier when the lag bound falls before it, so the lag is stated at the bound.
     */
    private computeDueAtMs(): number | undefined {
        const oldestAtMs = this.input.dirty.getOldestDirtiedAtMs();
        if (oldestAtMs === undefined) {
            return undefined;
        }
        const { intervalMs, lagBoundMs } = this.input.settings;
        const checkpointDueAtMs = Math.max(oldestAtMs + intervalMs, this.retryNotBeforeMs);
        return this.lagStated ? checkpointDueAtMs : Math.min(checkpointDueAtMs, oldestAtMs + lagBoundMs + 1);
    }

    private fire(): void {
        this.cancelTimer = undefined;
        if (this.disposed) {
            return;
        }
        this.recordLag();
        if (this.input.nowMs() >= this.retryNotBeforeMs) {
            this.startWrite();
            return;
        }
        this.arm();
    }

    /** The snapshot and the capture share one turn, so what the write saves is one state the pair was in. */
    private startWrite(): void {
        const { dirty, memory } = this.input;
        if (dirty.isClean()) {
            return;
        }
        const snapshot = dirty.getSnapshot();
        const mutations = computeALCheckpointMutations({
            snapshot,
            peekAdmission: (key) => memory.peek(key),
            peekQueueEntry: (key) => memory.workQueue.peek(key),
            writeToken: this.input.newWriteToken()
        });
        this.inFlight = snapshot;
        this.disarm();
        void this.input.write(mutations).then(
            () => this.completeWrite(snapshot),
            (error) => this.failWrite(toError(error))
        );
    }

    private completeWrite(snapshot: ALCheckpointDirtySet.Snapshot): void {
        this.inFlight = undefined;
        this.input.dirty.clearSaved(snapshot);
        this.retryNotBeforeMs = Number.NEGATIVE_INFINITY;
        this.lastWriteFailure = undefined;
        this.lagStated = false;
        this.input.health.recordRecoveryPoint(this.input.nowMs());
        this.continueAfterWrite();
    }

    /** The saved rows stand as the aborted transaction left them; every captured key stays unsaved. */
    private failWrite(error: Error): void {
        this.inFlight = undefined;
        this.retryNotBeforeMs = this.input.nowMs() + this.input.settings.intervalMs;
        this.lastWriteFailure = toALStorageFailure(error);
        this.continueAfterWrite();
    }

    /** A flush asked for during the write still runs after a dispose: it is the disposing page's last save. */
    private continueAfterWrite(): void {
        this.disarm();
        if (this.flushRequested) {
            this.flushRequested = false;
            this.startWrite();
            return;
        }
        if (this.disposed) {
            return;
        }
        this.recordLag();
        this.arm();
    }

    /**
     * `failing` once past the bound; else `delayed` once a write failed or the oldest unsaved change is two
     * intervals old, never for a timer a few milliseconds late. A completed write ends either.
     */
    private recordLag(): void {
        const oldestAtMs = this.input.dirty.getOldestDirtiedAtMs();
        if (oldestAtMs === undefined) {
            return;
        }
        const ageMs = this.input.nowMs() - oldestAtMs;
        const { settings, health } = this.input;
        if (ageMs > settings.lagBoundMs && !this.lagStated) {
            this.lagStated = true;
            health.recordLagFailure(computeALCheckpointLagFailure(ageMs, settings, this.lastWriteFailure), ageMs);
        }
        else if (this.lastWriteFailure !== undefined || ageMs >= 2 * settings.intervalMs) {
            health.recordDelayed(ageMs, this.lastWriteFailure);
        }
    }
}

function computeALCheckpointLagFailure(
    ageMs: number,
    settings: ALCheckpointWriter.Settings,
    lastWriteFailure: ALStorageUnavailable | undefined
): ALStorageUnavailable {
    const lastWrite = lastWriteFailure === undefined ? '' : ` The last checkpoint failed: ${lastWriteFailure.detail}`;
    return {
        cause: 'checkpoint-lag',
        detail: `The oldest unsaved change is ${ageMs} ms old, beyond the ${settings.lagBoundMs} ms bound.${lastWrite}`
    };
}
