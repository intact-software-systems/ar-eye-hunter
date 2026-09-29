import type { ResourceInboxWorkPage } from '../../../queuebox/queue-box-types.ts';
import type { ALWorkQueuePort } from '../../work/al-work-queue-port.ts';

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
}

interface ALInboundHeldRead<TRead extends ALInboundRotationRead> {
    readonly selection: Promise<TRead>;
    readonly head: boolean;
}

export namespace ALInboundRotationPage {
    export interface Dependencies<TRead extends ALInboundRotationRead> {
        /** Reads one page from `scan`; the page stores the position it returns only for a rotation read. */
        readonly readPage: (
            port: ALWorkQueuePort,
            scan: ALInboundWorkScan,
            pageSize: number
        ) => Promise<TRead>;
    }
}

/**
 * The one page a rotation round holds between its readiness probe and the batch that follows it,
 * and the position the rotation has reached. A commit asks for one read from the head of NEW,
 * which leaves that position where it stood; at most one such read runs between two rotation
 * reads, so the rotation advances at least every other batch while commits keep arriving.
 */
export class ALInboundRotationPage<TRead extends ALInboundRotationRead> {
    private readonly dependencies: ALInboundRotationPage.Dependencies<TRead>;
    private scan: ALInboundWorkScan = AL_INBOUND_SCAN_START;
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
            return this.advance(await read.selection);
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

    passSelection(pending: Promise<TRead>, selection: TRead): void {
        const read = this.held;
        if (read?.selection !== pending) {
            return;
        }
        this.held = undefined;
        if (read.head) {
            this.consumeHeadRead();
        }
        else {
            this.advance(selection);
        }
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
        this.held = { selection: this.dependencies.readPage(port, scan, pageSize), head };
        return this.held;
    }

    private consumeHeadRead(): void {
        this.headRead = 'none';
        this.headSinceRotation = true;
    }

    private advance(selection: TRead): TRead {
        this.scan = selection.scan;
        this.headSinceRotation = false;
        if (this.headRead === 'deferred') {
            this.headRead = 'pending';
        }
        return selection;
    }
}

/** A rotation at its start reads the head of NEW anyway, so a head read there is the rotation read. */
function isALInboundScanStart(scan: ALInboundWorkScan): boolean {
    return scan.cursor === null && scan.statusIndex === 0;
}
