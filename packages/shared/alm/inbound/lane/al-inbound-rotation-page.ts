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
    /** The clock reading the page was read at. */
    readonly readAtMs: number;
    /** Due rows the page held back. */
    readonly deferred: readonly ALInboundDeferredEffect[];
}

interface ALInboundHeldRead<TRead extends ALInboundRotationRead> {
    readonly selection: Promise<TRead>;
    readonly head: boolean;
    /** The position a rotation read started from; it may store its own only while the rotation still stands there. */
    readonly from: ALInboundWorkScan;
}

/** The rotation walked since it last left the head of NEW. */
interface ALInboundRotationProgress {
    readonly startedAtMs: number | undefined;
    readonly deferred: readonly ALInboundDeferredEffect[];
}

const AL_INBOUND_ROTATION_UNSTARTED: ALInboundRotationProgress = { startedAtMs: undefined, deferred: [] };

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
        readonly startedAtMs: number;
        readonly completedAtMs: number;
        /** The due rows its pages held back, oldest first, at most `deferredLimit` of them. */
        readonly deferred: readonly ALInboundDeferredEffect[];
    }

    /**
     * What passing a probed page did: moved the rotation on, brought it back to the head of NEW, served a
     * commit's head read, or stored nothing because a commit or a batch took the rotation elsewhere meanwhile.
     */
    export type Pass = 'advanced' | 'wrapped' | 'head-read' | 'dropped';
}

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
    /** A batch took a head read, and no rotation read has moved the position since. */
    private headSinceRotation = false;

    constructor(dependencies: ALInboundRotationPage.Dependencies<TRead>) {
        this.dependencies = dependencies;
    }

    readSelection(port: ALWorkQueuePort, pageSize: number): Promise<TRead> {
        return this.readHeld(port, pageSize).selection;
    }

    async takeSelection(port: ALWorkQueuePort, pageSize: number): Promise<TRead> {
        const read = this.readHeld(port, pageSize);
        this.held = undefined;
        if (!read.head) {
            const selection = await read.selection;
            this.advance(read, selection);
            return selection;
        }
        this.consumeHeadRead();
        try {
            return await read.selection;
        }
        catch (error) {
            this.headRead = 'pending';
            this.headSinceRotation = false;
            throw error;
        }
    }

    passSelection(pending: Promise<TRead>, selection: TRead): ALInboundRotationPage.Pass {
        const read = this.held;
        if (read?.selection !== pending) {
            return 'dropped';
        }
        this.held = undefined;
        if (read.head) {
            this.consumeHeadRead();
            return 'head-read';
        }
        return this.advance(read, selection);
    }

    dropSelection(pending: Promise<TRead>): void {
        if (this.held?.selection === pending) {
            this.held = undefined;
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
        const scan = head
            ? { ...AL_INBOUND_SCAN_START, nextReadyAtMs: this.scan.nextReadyAtMs }
            : this.scan;
        this.held = { selection: this.dependencies.readPage(port, scan, pageSize), head, from: this.scan };
        return this.held;
    }

    private consumeHeadRead(): void {
        this.headRead = 'none';
        this.headSinceRotation = true;
    }

    private advance(read: ALInboundHeldRead<TRead>, selection: TRead): ALInboundRotationPage.Pass {
        if (read.from !== this.scan) {
            return 'dropped';
        }
        this.scan = selection.scan;
        this.headSinceRotation = false;
        if (this.headRead === 'deferred') {
            this.headRead = 'pending';
        }
        const wrapped = isALInboundScanStart(selection.scan);
        this.recordRotationRead(selection, wrapped);
        return wrapped ? 'wrapped' : 'advanced';
    }

    private recordRotationRead(selection: TRead, wrapped: boolean): void {
        const startedAtMs = this.rotation.startedAtMs ?? selection.readAtMs;
        const deferred = toOldestFirstALInboundDeferredEffects([...this.rotation.deferred, ...selection.deferred])
            .slice(0, this.dependencies.deferredLimit);
        this.rotation = wrapped ? AL_INBOUND_ROTATION_UNSTARTED : { startedAtMs, deferred };
        if (wrapped) {
            this.dependencies.onRotationCompleted({ startedAtMs, completedAtMs: this.dependencies.nowMs(), deferred });
        }
    }
}

/** A rotation at its start reads the head of NEW anyway, so a head read there is the rotation read. */
function isALInboundScanStart(scan: ALInboundWorkScan): boolean {
    return scan.cursor === null && scan.statusIndex === 0;
}
