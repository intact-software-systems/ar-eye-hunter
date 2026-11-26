import type {
    OrderedSendCellArrival,
    OrderedSendCellHandOff,
    OrderedSendCellObservations,
    OrderedSendCellReceipt,
    OrderedSendCellSend
} from './ordered-send-cell-observations.ts';

/** One read of a copy: its instant and its place in `arrivals`, the order the cell observed reads in. */
export interface ObservedOrderedSendRead {
    readonly atMs: number;
    readonly arrivalPosition: number;
}

/** One expected recipient's share of a send. */
export interface ObservedOrderedSendCopy {
    readonly recipientPeerId: string;
    /** In the order observed; empty when the recipient never read its copy. */
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
    return [...toOrderedSendByMsgId(observations.sends).values()].map((send) => ({
        send,
        copies: toObservedOrderedSendCopies(send, arrivalsByMsgId.get(send.msgId) ?? []),
        handOffs: handOffsByMsgId.get(send.msgId) ?? [],
        receipts: receiptsByMsgId.get(send.msgId) ?? []
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
