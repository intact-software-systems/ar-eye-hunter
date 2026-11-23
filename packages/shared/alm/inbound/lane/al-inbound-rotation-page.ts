import type { ResourceInboxWorkPage } from '../../../queuebox/queue-box-types.ts';
import type { ALWorkQueuePort } from '../../work/al-work-queue-port.ts';
import {
    toOldestFirstALInboundDeferredEffects,
    type ALInboundDeferredEffect
} from '../al-inbound-runtime-diagnostics.ts';

export interface ALInboundWorkScan {
    readonly cursor: ResourceInboxWorkPage.Cursor | null;
    readonly statusIndex: number;
    readonly nextReadyAtMs: number | undefined;
}

const AL_INBOUND_SCAN_START: ALInboundWorkScan = {
    cursor: null,
    statusIndex: 0,
    nextReadyAtMs: undefined
};

export interface ALInboundRotationRead {
    readonly scan: ALInboundWorkScan;
    /** Due rows the page held back. */
    readonly deferred: readonly ALInboundDeferredEffect[];
    /** The page holds work a batch can claim. */
    readonly readyNow: boolean;
    /** The earliest readiness this page, and the rotation's pages before it, scanned. */
    readonly nextReadyAtMs: number | undefined;
}

/** One page read, with when it started and what it cost from before `readPage` to its settlement. */
interface ALInboundTimedRead<TRead extends ALInboundRotationRead> {
    readonly read: TRead;
    readonly startedAtMs: number;
    readonly durationMs: number;
}

interface ALInboundHeldRead<TRead extends ALInboundRotationRead> {
    readonly selection: Promise<ALInboundTimedRead<TRead>>;
    readonly head: boolean;
    /** The position a rotation read started from; it may store its own only while the rotation still stands there. */
    readonly from: ALInboundWorkScan;
}

/** The rotation walked since it last left the head of NEW. */
interface ALInboundRotationProgress {
    readonly startedAtMs: number | undefined;
    readonly readDurationMs: number;
    readonly deferred: readonly ALInboundDeferredEffect[];
}

const AL_INBOUND_ROTATION_UNSTARTED: ALInboundRotationProgress = {
    startedAtMs: undefined,
    readDurationMs: 0,
    deferred: []
};

/** What one walk has read so far: whether it began a rotation at the head of NEW, and its head reads' readiness. */
interface ALInboundWalkProgress {
    readonly fromHead: boolean;
    readonly headReadyAtMs: number | undefined;
}

const AL_INBOUND_WALK_UNSTARTED: ALInboundWalkProgress = { fromHead: false, headReadyAtMs: undefined };

export namespace ALInboundRotationPage {
    export interface Dependencies<TRead extends ALInboundRotationRead> {
        /** Reads one page from `scan`; the page stores the position it returns only for a rotation read. */
        readonly readPage: (
            port: ALWorkQueuePort,
            scan: ALInboundWorkScan,
            pageSize: number
        ) => Promise<TRead>;
        readonly nowMs: () => number;
        /** How many held-back rows a completed rotation names, oldest first. */
        readonly deferredLimit: number;
        /** Called once per rotation, by the read that brought it back to the head of NEW. */
        readonly onRotationCompleted: (rotation: CompletedRotation) => void;
    }

    /** One rotation from its first page read to the read that wrapped it, whichever probes and batches read its pages. */
    export interface CompletedRotation {
        /** When its first page read started. */
        readonly startedAtMs: number;
        /** When the read that wrapped it settled. */
        readonly completedAtMs: number;
        /** Its own page reads, summed, each from before `readPage` to its settlement: no time between them. */
        readonly readDurationMs: number;
        /** The due rows its pages held back, oldest first, at most `deferredLimit` of them. */
        readonly deferred: readonly ALInboundDeferredEffect[];
    }

    /**
     * Where a walk stopped: at a page a batch can claim from, held for it; at the wrap of a rotation it
     * read from the head of NEW, with the earliest readiness it scanned; or at a read a commit or a
     * batch took from it meanwhile.
     */
    export type Walk =
        | Readonly<{ kind: 'ready'; }>
        | Readonly<{ kind: 'wrapped'; readyAtMs: number | undefined; }>
        | Readonly<{ kind: 'dropped'; }>;
}

/** What a walked read did to the walk: ended it, or left it to read on. */
type ALInboundWalkStep =
    | Readonly<{ kind: 'ended'; walk: ALInboundRotationPage.Walk; }>
    | Readonly<{ kind: 'continued'; progress: ALInboundWalkProgress; }>;

/**
 * The one page held between a readiness probe and the batch that follows it, and the position the
 * rotation has reached. Only a rotation read moves that position, and only from the position it was
 * read at, so each position is passed once and a completed rotation is reported once. A commit asks
 * for one read from the head of NEW, which leaves the position where it stood; at most one such read
 * runs between two rotation reads, so the rotation advances at least every other read while commits
 * keep arriving.
 */
export class ALInboundRotationPage<TRead extends ALInboundRotationRead> {
    private readonly dependencies: ALInboundRotationPage.Dependencies<TRead>;
    private scan: ALInboundWorkScan = AL_INBOUND_SCAN_START;
    private rotation: ALInboundRotationProgress = AL_INBOUND_ROTATION_UNSTARTED;
    private held: ALInboundHeldRead<TRead> | undefined;
    private headRead: 'none' | 'pending' | 'deferred' = 'none';
    /** A head read ran, and no rotation read has moved the position since. */
    private headSinceRotation = false;

    constructor(dependencies: ALInboundRotationPage.Dependencies<TRead>) {
        this.dependencies = dependencies;
    }

    /**
     * Reads pages back to back from the stored position until one holds work a batch can claim, or
     * until a rotation the walk read from the head of NEW wraps: a walk that starts mid-way finishes
     * that rotation and reads one more whole, so it never answers without having read every status.
     * A read a commit or a batch took meanwhile ends the walk: that commit owes a head read, and the
     * batch it starts runs it. Every other read moves the stored position on or is the one head read
     * allowed between two of those, so a walk reads at most about two rotations.
     */
    async walkToReadyPage(port: ALWorkQueuePort, pageSize: number): Promise<ALInboundRotationPage.Walk> {
        let progress = AL_INBOUND_WALK_UNSTARTED;
        for (;;) {
            const read = this.readHeld(port, pageSize);
            let timed: ALInboundTimedRead<TRead>;
            try {
                timed = await read.selection;
            }
            catch (error) {
                this.dropSelection(read);
                throw error;
            }
            const step = this.passWalkedRead(read, timed, progress);
            if (step.kind === 'ended') {
                return step.walk;
            }
            progress = step.progress;
        }
    }

    async takeSelection(port: ALWorkQueuePort, pageSize: number): Promise<TRead> {
        const read = this.readHeld(port, pageSize);
        this.held = undefined;
        if (!read.head) {
            const timed = await read.selection;
            this.advance(read, timed);
            return timed.read;
        }
        this.consumeHeadRead();
        try {
            return (await read.selection).read;
        }
        catch (error) {
            this.headRead = 'pending';
            this.headSinceRotation = false;
            throw error;
        }
    }

    /**
     * A commit wrote work behind the rotation. The next read starts at the head of NEW, unless a head
     * read already ran since the last rotation read: that commit waits for the read after the next
     * rotation read.
     */
    requestHeadRead(): void {
        if (this.headSinceRotation) {
            this.headRead = 'deferred';
            return;
        }
        this.headRead = 'pending';
        this.held = undefined;
    }

    isHeadReadPending(): boolean {
        return this.headRead === 'pending';
    }

    private readHeld(port: ALWorkQueuePort, pageSize: number): ALInboundHeldRead<TRead> {
        if (this.held !== undefined) {
            return this.held;
        }
        const pending = this.headRead === 'pending';
        const head = pending && !isALInboundScanStart(this.scan);
        if (pending && !head) {
            this.headRead = 'none';
        }
        // A head read answers for its own page only: the readiness the resting position carries is the
        // partial rotation's, which the rotation read that resumes there still holds.
        const scan = head ? AL_INBOUND_SCAN_START : this.scan;
        const { nowMs, readPage } = this.dependencies;
        const startedAtMs = nowMs();
        const selection = readPage(port, scan, pageSize)
            .then((read) => ({ read, startedAtMs, durationMs: Math.max(0, nowMs() - startedAtMs) }));
        this.held = { selection, head, from: this.scan };
        return this.held;
    }

    /** A read a commit or a batch took meanwhile is no longer held, and stores nothing. */
    private passWalkedRead(
        read: ALInboundHeldRead<TRead>,
        timed: ALInboundTimedRead<TRead>,
        progress: ALInboundWalkProgress
    ): ALInboundWalkStep {
        if (this.held !== read) {
            return { kind: 'ended', walk: { kind: 'dropped' } };
        }
        if (timed.read.readyNow) {
            return { kind: 'ended', walk: { kind: 'ready' } };
        }
        this.held = undefined;
        if (read.head) {
            this.consumeHeadRead();
            const headReadyAtMs = toEarliestALInboundReadyAtMs(progress.headReadyAtMs, timed.read.nextReadyAtMs);
            return { kind: 'continued', progress: { ...progress, headReadyAtMs } };
        }
        const advanced = this.advance(read, timed);
        if (advanced === 'dropped') {
            return { kind: 'ended', walk: { kind: 'dropped' } };
        }
        const fromHead = progress.fromHead || isALInboundScanStart(read.from);
        if (advanced === 'wrapped' && fromHead) {
            const readyAtMs = toEarliestALInboundReadyAtMs(progress.headReadyAtMs, timed.read.nextReadyAtMs);
            return { kind: 'ended', walk: { kind: 'wrapped', readyAtMs } };
        }
        return { kind: 'continued', progress: { ...progress, fromHead } };
    }

    private dropSelection(read: ALInboundHeldRead<TRead>): void {
        if (this.held === read) {
            this.held = undefined;
        }
    }

    private consumeHeadRead(): void {
        this.headRead = 'none';
        this.headSinceRotation = true;
    }

    private advance(
        read: ALInboundHeldRead<TRead>,
        timed: ALInboundTimedRead<TRead>
    ): 'advanced' | 'wrapped' | 'dropped' {
        if (read.from !== this.scan) {
            return 'dropped';
        }
        this.scan = timed.read.scan;
        this.headSinceRotation = false;
        if (this.headRead === 'deferred') {
            this.headRead = 'pending';
        }
        const wrapped = isALInboundScanStart(timed.read.scan);
        this.recordRotationRead(timed, wrapped);
        return wrapped ? 'wrapped' : 'advanced';
    }

    private recordRotationRead(timed: ALInboundTimedRead<TRead>, wrapped: boolean): void {
        const startedAtMs = this.rotation.startedAtMs ?? timed.startedAtMs;
        const readDurationMs = this.rotation.readDurationMs + timed.durationMs;
        const deferred = toOldestFirstALInboundDeferredEffects([...this.rotation.deferred, ...timed.read.deferred])
            .slice(0, this.dependencies.deferredLimit);
        this.rotation = wrapped ? AL_INBOUND_ROTATION_UNSTARTED : { startedAtMs, readDurationMs, deferred };
        if (wrapped) {
            this.dependencies.onRotationCompleted({
                startedAtMs,
                completedAtMs: timed.startedAtMs + timed.durationMs,
                readDurationMs,
                deferred
            });
        }
    }
}

/** A rotation at its start reads the head of NEW anyway, so a head read there is the rotation read. */
function isALInboundScanStart(scan: ALInboundWorkScan): boolean {
    return scan.cursor === null && scan.statusIndex === 0;
}

function toEarliestALInboundReadyAtMs(left: number | undefined, right: number | undefined): number | undefined {
    if (left === undefined || right === undefined) {
        return left ?? right;
    }
    return Math.min(left, right);
}
