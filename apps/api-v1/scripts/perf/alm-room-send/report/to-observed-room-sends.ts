import type {
    RoomSendCellAck,
    RoomSendCellArrival,
    RoomSendCellControl,
    RoomSendCellDeclinedRepair,
    RoomSendCellHandOff,
    RoomSendCellObservations,
    RoomSendCellReceipt,
    RoomSendCellResend,
    RoomSendCellSend,
    RoomSendCellSendEnd
} from '../room-send-cell-observations.ts';

/**
 * One write of a copy to its recipient's socket, as the cell read it there: its instant, its place in `arrivals`, and
 * whether the envelope of its frame named an ordering key.
 */
export interface ObservedRoomSendRead {
    readonly atMs: number;
    readonly arrivalPosition: number;
    readonly namesOrderingKey: boolean;
}

/** One expected recipient's share of a send. */
export interface ObservedRoomSendCopy {
    readonly recipientPeerId: string;
    /** In the order observed; empty when the server never wrote the copy to its recipient's socket. */
    readonly reads: readonly ObservedRoomSendRead[];
}

/** A send joined with what the cell observed of it. What joins no send is counted by the report's `unmatched`. */
export interface ObservedRoomSend {
    readonly send: RoomSendCellSend;
    /** One for each expected recipient; an arrival at any other recipient is in none. */
    readonly copies: readonly ObservedRoomSendCopy[];
    /** In the order observed. */
    readonly handOffs: readonly RoomSendCellHandOff[];
    /** In the order observed. */
    readonly receipts: readonly RoomSendCellReceipt[];
    /** In the order observed. */
    readonly controls: readonly RoomSendCellControl[];
    /** The later offers of the send, in the order offered. */
    readonly resends: readonly RoomSendCellResend[];
    /** The ACKs its recipients offered of the send, in the order offered. */
    readonly acks: readonly RoomSendCellAck[];
    /** The ends its publisher's stand-in recorded of the send: at most one in a run of the cell. */
    readonly sendEnds: readonly RoomSendCellSendEnd[];
    /** The repairs its publisher's stand-in declined of the send, in the order declined. */
    readonly declinedRepairs: readonly RoomSendCellDeclinedRepair[];
}

interface PositionedRoomSendArrival {
    readonly arrival: RoomSendCellArrival;
    readonly arrivalPosition: number;
}

export function toObservedRoomSends(observations: RoomSendCellObservations): readonly ObservedRoomSend[] {
    const arrivalsByMsgId = Map.groupBy(
        observations.arrivals.map((arrival, arrivalPosition): PositionedRoomSendArrival => ({
            arrival,
            arrivalPosition
        })),
        ({ arrival }) => arrival.msgId
    );
    const handOffsByMsgId = Map.groupBy(observations.handOffs, (handOff) => handOff.msgId);
    const receiptsByMsgId = Map.groupBy(observations.receipts, (receipt) => receipt.msgId);
    const controlsByMsgId = Map.groupBy(observations.controls, (control) => control.msgId);
    const resendsByMsgId = Map.groupBy(observations.resends, (resend) => resend.msgId);
    const acksByMsgId = Map.groupBy(observations.acks, (ack) => ack.msgId);
    const sendEndsByMsgId = Map.groupBy(observations.sendEnds, (end) => end.msgId);
    const declinedRepairsByMsgId = Map.groupBy(observations.declinedRepairs, (declined) => declined.msgId);
    return [...toRoomSendByMsgId(observations.sends).values()].map((send) => ({
        send,
        copies: toObservedRoomSendCopies(send, arrivalsByMsgId.get(send.msgId) ?? []),
        handOffs: handOffsByMsgId.get(send.msgId) ?? [],
        receipts: receiptsByMsgId.get(send.msgId) ?? [],
        controls: controlsByMsgId.get(send.msgId) ?? [],
        resends: resendsByMsgId.get(send.msgId) ?? [],
        acks: acksByMsgId.get(send.msgId) ?? [],
        sendEnds: sendEndsByMsgId.get(send.msgId) ?? [],
        declinedRepairs: declinedRepairsByMsgId.get(send.msgId) ?? []
    }));
}

/** A msgId belongs to the first send in the list that carries it; a later send repeating it joins nothing. */
export function toRoomSendByMsgId(
    sends: readonly RoomSendCellSend[]
): ReadonlyMap<string, RoomSendCellSend> {
    return new Map(
        [...Map.groupBy(sends, (send) => send.msgId)].map(([msgId, [firstSend]]) => [msgId, firstSend])
    );
}

function toObservedRoomSendCopies(
    send: RoomSendCellSend,
    arrivals: readonly PositionedRoomSendArrival[]
): readonly ObservedRoomSendCopy[] {
    const arrivalsByRecipient = Map.groupBy(arrivals, ({ arrival }) => arrival.recipientPeerId);
    return send.expectedRecipientPeerIds.map((recipientPeerId) => ({
        recipientPeerId,
        reads: (arrivalsByRecipient.get(recipientPeerId) ?? []).map(({ arrival, arrivalPosition }) => ({
            atMs: arrival.atMs,
            arrivalPosition,
            namesOrderingKey: arrival.namesOrderingKey
        }))
    }));
}
