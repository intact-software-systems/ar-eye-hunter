import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';

import type {
    OrderedSendCellArrival,
    OrderedSendCellControl,
    OrderedSendCellReceipt,
    OrderedSendCellUnclassifiedControl
} from './ordered-send-cell-observations.ts';

export interface ToOrderedSendSocketReadInput {
    /** The envelope of the frame the socket read. */
    readonly message: ALMessage;
    /** The session whose socket read it. */
    readonly readerPeerId: string;
    /** The instant it was read at. */
    readonly atMs: number;
}

/** What one frame a session's socket read is to the cell: the one observation it is recorded as. */
export type OrderedSendSocketRead =
    | { readonly kind: 'arrival'; readonly arrival: OrderedSendCellArrival; }
    | { readonly kind: 'receipt'; readonly receipt: OrderedSendCellReceipt; }
    | { readonly kind: 'control'; readonly control: OrderedSendCellControl; }
    | { readonly kind: 'unclassified-control'; readonly unclassifiedControl: OrderedSendCellUnclassifiedControl; };

/**
 * A message that is no control is an arrival of it at its reader, whoever that is. A control names the message it is
 * about in its payload, never by its own envelope: a receipt, a NACK and a repair request are each recorded of that
 * message, and any other control, an ACK or one whose payload does not decode, stays unclassified under its type.
 */
export function toOrderedSendSocketRead(input: ToOrderedSendSocketReadInput): OrderedSendSocketRead {
    const { message, readerPeerId, atMs } = input;
    if (!isALControlTypeId(message.payload.typeId)) {
        return { kind: 'arrival', arrival: { msgId: message.id.msgId, recipientPeerId: readerPeerId, atMs } };
    }
    const control = decodeALControlMessage(message).right;
    switch (control?.type) {
        case 'receipt':
            return { kind: 'receipt', receipt: { msgId: control.payload.msgId, phase: control.payload.phase, atMs } };
        case 'nack':
            return {
                kind: 'control',
                control: { type: 'nack', msgId: control.payload.msgId, reason: control.payload.reason, atMs }
            };
        case 'repair':
            return {
                kind: 'control',
                control: { type: 'repair', msgId: control.payload.msgId, reason: control.payload.reason, atMs }
            };
        case 'ack':
        case undefined:
            return { kind: 'unclassified-control', unclassifiedControl: { typeId: message.payload.typeId, atMs } };
    }
}
