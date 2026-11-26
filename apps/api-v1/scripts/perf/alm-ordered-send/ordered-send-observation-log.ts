import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALControlMessage, type ALReceiptPayload } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';

import type {
    OrderedSendCellArrival,
    OrderedSendCellHandOff,
    OrderedSendCellObservations,
    OrderedSendCellReceipt
} from './ordered-send-cell-observations.ts';

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
    /** One entry for each copy a session read at least once. */
    private readonly copiesRead = new Set<string>();
    private readonly terminalMsgIds = new Set<string>();
    private observing = true;

    constructor(nowMs: () => number) {
        this.nowMs = nowMs;
    }

    /**
     * Records one frame a session's socket read: a receipt as a receipt, and every message that is no control as
     * an arrival, whoever read it. Any other control, a NACK or a repair request, is recorded nowhere: the
     * observations have no list for it. Returns the copy when the reader now owes its ACK: the session's first read
     * of a message another session sent that asks for a receipt. Throws on a frame that is no AL envelope, which
     * the server never writes to a session's socket.
     */
    recordSocketFrame(readerPeerId: string, frame: string): ALMessage | undefined {
        const message = decodePersistedALMessage(frame);
        if (!this.observing) {
            return undefined;
        }
        if (isALControlTypeId(message.payload.typeId)) {
            this.recordControl(message);
            return undefined;
        }
        this.arrivals.push({ msgId: message.id.msgId, recipientPeerId: readerPeerId, atMs: this.nowMs() });
        const copyRead = JSON.stringify([readerPeerId, message.id.msgId]);
        const isFirstRead = !this.copiesRead.has(copyRead);
        this.copiesRead.add(copyRead);
        const asksForReceipt = message.delivery !== undefined && message.delivery.ack !== 'none';
        return isFirstRead && asksForReceipt && message.id.senderId !== readerPeerId ? message : undefined;
    }

    recordHandOff(msgId: string, instanceIndex: number): void {
        if (this.observing) {
            this.handOffs.push({ msgId, instanceIndex, atMs: this.nowMs() });
        }
    }

    isObserving(): boolean {
        return this.observing;
    }

    /** Whether a `complete` or a `timed-out` receipt of the send was read while observation lasted. */
    hasTerminalReceipt(msgId: string): boolean {
        return this.terminalMsgIds.has(msgId);
    }

    /** Stops observation at the instant it reads, and returns everything recorded up to it. */
    endObservation(): OrderedSendObservedReads {
        this.observing = false;
        return {
            arrivals: [...this.arrivals],
            handOffs: [...this.handOffs],
            receipts: [...this.receipts],
            observationEndedAtMs: this.nowMs()
        };
    }

    private recordControl(message: ALMessage): void {
        const control = decodeALControlMessage(message).right;
        if (control?.type !== 'receipt') {
            return;
        }
        const { msgId, phase } = control.payload;
        this.receipts.push({ msgId, phase, atMs: this.nowMs() });
        if (ORDERED_SEND_TERMINAL_RECEIPT_PHASES[phase]) {
            this.terminalMsgIds.add(msgId);
        }
    }
}

/** A phase added to the receipt contract has no key here, and fails to compile. */
const ORDERED_SEND_TERMINAL_RECEIPT_PHASES: Readonly<Record<ALReceiptPayload['phase'], boolean>> = {
    admitted: false,
    complete: true,
    'timed-out': true
};
