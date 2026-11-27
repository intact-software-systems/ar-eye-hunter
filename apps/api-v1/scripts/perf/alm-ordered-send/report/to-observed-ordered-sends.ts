import type {
    OrderedSendCellAck,
    OrderedSendCellArrival,
    OrderedSendCellControl,
    OrderedSendCellDeclinedRepair,
    OrderedSendCellHandOff,
    OrderedSendCellObservations,
    OrderedSendCellReceipt,
    OrderedSendCellResend,
    OrderedSendCellSend,
    OrderedSendCellSendEnd
} from '../ordered-send-cell-observations.ts';

/** One write of a copy to its recipient's socket, as the cell read it there: its instant and its place in `arrivals`. */
export interface ObservedOrderedSendRead {
    readonly atMs: number;
    readonly arrivalPosition: number;
}

/** One expected recipient's share of a send. */
export interface ObservedOrderedSendCopy {
    readonly recipientPeerId: string;
    /** In the order observed; empty when the server never wrote the copy to its recipient's socket. */
    readonly reads: readonly ObservedOrderedSendRead[];
}

/** A send joined with what the cell observed of it. What joins no send is counted by the report's `unmatched`. */
export interface ObservedOrderedSend {
    readonly send: OrderedSendCellSend;
    /** One for each expected recipient; an arrival at any other recipient is in none. */
    readonly copies: readonly ObservedOrderedSendCopy[];
    /** In the order observed. */
    readonly handOffs: readonly OrderedSendCellHandOff[];
    /** In the order observed. */
    readonly receipts: readonly OrderedSendCellReceipt[];
    /** In the order observed. */
    readonly controls: readonly OrderedSendCellControl[];
    /** The later offers of the send, in the order offered. */
    readonly resends: readonly OrderedSendCellResend[];
    /** The ACKs its recipients offered of the send, in the order offered. */
    readonly acks: readonly OrderedSendCellAck[];
    /** The ends its publisher's stand-in recorded of the send: at most one in a run of the cell. */
    readonly sendEnds: readonly OrderedSendCellSendEnd[];
    /** The repairs its publisher's stand-in declined of the send, in the order declined. */
    readonly declinedRepairs: readonly OrderedSendCellDeclinedRepair[];
}

interface PositionedOrderedSendArrival {
    readonly arrival: OrderedSendCellArrival;
    readonly arrivalPosition: number;
}

export function toObservedOrderedSends(observations: OrderedSendCellObservations): readonly ObservedOrderedSend[] {
    const arrivalsByMsgId = Map.groupBy(
        observations.arrivals.map((arrival, arrivalPosition): PositionedOrderedSendArrival => ({
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
    return [...toOrderedSendByMsgId(observations.sends).values()].map((send) => ({
        send,
        copies: toObservedOrderedSendCopies(send, arrivalsByMsgId.get(send.msgId) ?? []),
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
export function toOrderedSendByMsgId(
    sends: readonly OrderedSendCellSend[]
): ReadonlyMap<string, OrderedSendCellSend> {
    return new Map(
        [...Map.groupBy(sends, (send) => send.msgId)].map(([msgId, [firstSend]]) => [msgId, firstSend])
    );
}

function toObservedOrderedSendCopies(
    send: OrderedSendCellSend,
    arrivals: readonly PositionedOrderedSendArrival[]
): readonly ObservedOrderedSendCopy[] {
    const arrivalsByRecipient = Map.groupBy(arrivals, ({ arrival }) => arrival.recipientPeerId);
    return send.expectedRecipientPeerIds.map((recipientPeerId) => ({
        recipientPeerId,
        reads: (arrivalsByRecipient.get(recipientPeerId) ?? []).map(({ arrival, arrivalPosition }) => ({
            atMs: arrival.atMs,
            arrivalPosition
        }))
    }));
}
