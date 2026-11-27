import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { isALControlTypeId } from '@shared/al-contracts/al-control-type-ids.ts';
import { decodeALControlMessage, type ALPeerRepairControlMessage } from '@shared/al-contracts/al-control.ts';

import type {
    RoomSendCellArrival,
    RoomSendCellControl,
    RoomSendCellReceipt,
    RoomSendCellUnclassifiedControl
} from './room-send-cell-observations.ts';

export interface ToRoomSendSocketReadInput {
    /** The envelope of the frame the socket read. */
    readonly message: ALMessage;
    /** The session whose socket read it. */
    readonly readerPeerId: string;
    /** The instant it was read at. */
    readonly atMs: number;
}

/**
 * What one frame a session's socket read is to the cell: the one observation it is recorded as. A NACK or a repair
 * request also carries all it asks, `request`: the track, the missing ranges and the request's number, which a
 * publisher that answers it reads.
 */
export type RoomSendSocketRead =
    | { readonly kind: 'arrival'; readonly arrival: RoomSendCellArrival; }
    | { readonly kind: 'receipt'; readonly receipt: RoomSendCellReceipt; }
    | {
        readonly kind: 'control';
        readonly control: RoomSendCellControl;
        readonly request: ALPeerRepairControlMessage;
    }
    | { readonly kind: 'unclassified-control'; readonly unclassifiedControl: RoomSendCellUnclassifiedControl; };

/**
 * A message that is no control is an arrival of it at its reader, whoever that is, with whether its envelope names
 * an ordering key. A control names the message it is about in its payload, never by its own envelope: a receipt, a
 * NACK and a repair request are each recorded of that message, and any other control, an ACK or one whose payload
 * does not decode, stays unclassified under its type.
 */
export function toRoomSendSocketRead(input: ToRoomSendSocketReadInput): RoomSendSocketRead {
    const { message, readerPeerId, atMs } = input;
    if (!isALControlTypeId(message.payload.typeId)) {
        const namesOrderingKey = message.ordering?.orderingKey !== undefined;
        return {
            kind: 'arrival',
            arrival: { msgId: message.id.msgId, recipientPeerId: readerPeerId, atMs, namesOrderingKey }
        };
    }
    const control = decodeALControlMessage(message).right;
    switch (control?.type) {
        case 'receipt':
            return { kind: 'receipt', receipt: { msgId: control.payload.msgId, phase: control.payload.phase, atMs } };
        case 'nack':
            return {
                kind: 'control',
                control: { type: 'nack', msgId: control.payload.msgId, reason: control.payload.reason, atMs },
                request: control
            };
        case 'repair':
            return {
                kind: 'control',
                control: { type: 'repair', msgId: control.payload.msgId, reason: control.payload.reason, atMs },
                request: control
            };
        case 'ack':
        case undefined:
            return { kind: 'unclassified-control', unclassifiedControl: { typeId: message.payload.typeId, atMs } };
    }
}
