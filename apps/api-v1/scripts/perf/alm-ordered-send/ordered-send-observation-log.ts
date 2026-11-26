import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import type {
    OrderedSendCellArrival,
    OrderedSendCellControl,
    OrderedSendCellHandOff,
    OrderedSendCellObservations,
    OrderedSendCellReceipt,
    OrderedSendCellUnclassifiedControl
} from './ordered-send-cell-observations.ts';
import { toOrderedSendSocketRead } from './to-ordered-send-socket-read.ts';

/** What a run observes beside its sends. */
export type OrderedSendObservedReads = Omit<OrderedSendCellObservations, 'sends'>;

/**
 * What the sockets of the sessions read and what the instances handed to their application, each appended as it
 * happened and stamped by one clock. It records while observation lasts and nothing after it.
 */
export class OrderedSendObservationLog {
    private readonly nowMs: () => number;
    private readonly arrivals: OrderedSendCellArrival[] = [];
    private readonly handOffs: OrderedSendCellHandOff[] = [];
    private readonly receipts: OrderedSendCellReceipt[] = [];
    private readonly controls: OrderedSendCellControl[] = [];
    private readonly unclassifiedControls: OrderedSendCellUnclassifiedControl[] = [];
    /** One entry for each copy a session read at least once. */
    private readonly copiesRead = new Set<string>();
    private observing = true;

    constructor(nowMs: () => number) {
        this.nowMs = nowMs;
    }

    /**
     * Records one frame a session's socket read in the one list `toOrderedSendSocketRead` puts it in, at the instant
     * read here. Returns the copy when the reader now owes its ACK: the session's first read of a message another
     * session sent that asks for a receipt. Throws on a frame that is no AL envelope, which the server never writes
     * to a session's socket.
     */
    recordSocketFrame(readerPeerId: string, frame: string): ALMessage | undefined {
        const message = decodePersistedALMessage(frame);
        if (!this.observing) {
            return undefined;
        }
        const read = toOrderedSendSocketRead({ message, readerPeerId, atMs: this.nowMs() });
        switch (read.kind) {
            case 'arrival':
                this.arrivals.push(read.arrival);
                return this.recordCopyRead(readerPeerId, message) ? message : undefined;
            case 'receipt':
                this.receipts.push(read.receipt);
                return undefined;
            case 'control':
                this.controls.push(read.control);
                return undefined;
            case 'unclassified-control':
                this.unclassifiedControls.push(read.unclassifiedControl);
                return undefined;
        }
    }

    recordHandOff(msgId: string, instanceIndex: number): void {
        if (this.observing) {
            this.handOffs.push({ msgId, instanceIndex, atMs: this.nowMs() });
        }
    }

    isObserving(): boolean {
        return this.observing;
    }

    /** Stops observation at the instant it reads, and returns everything recorded up to it. */
    endObservation(): OrderedSendObservedReads {
        this.observing = false;
        return {
            arrivals: [...this.arrivals],
            handOffs: [...this.handOffs],
            receipts: [...this.receipts],
            controls: [...this.controls],
            unclassifiedControls: [...this.unclassifiedControls],
            observationEndedAtMs: this.nowMs()
        };
    }

    /** Whether the read is the one its reader owes an ACK for: its first of the copy, when the copy asks for one. */
    private recordCopyRead(readerPeerId: string, copy: ALMessage): boolean {
        const copyRead = JSON.stringify([readerPeerId, copy.id.msgId]);
        const isFirstRead = !this.copiesRead.has(copyRead);
        this.copiesRead.add(copyRead);
        const asksForReceipt = copy.delivery !== undefined && copy.delivery.ack !== 'none';
        return isFirstRead && asksForReceipt && copy.id.senderId !== readerPeerId;
    }
}
