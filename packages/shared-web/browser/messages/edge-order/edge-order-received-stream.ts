import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';

export interface EdgeOrderHeldMessage<Message> {
    readonly stamp: EdgeOrderStamp;
    readonly expiresAtMs: number;
    readonly byteLength: number;
    readonly heldSinceMs: number;
    readonly message: Message;
}

/** One sender's stream as its receiver keeps it. `EdgeOrderReceiver` owns every write. */
export interface EdgeOrderReceivedStream<Message> {
    readonly senderId: string;
    readonly streamId: string;
    readonly firstSeenAtMs: number;
    /** Absent while the stream is entering: nothing is handed over yet and earlier messages may still arrive. */
    nextPosition: number | undefined;
    /** The highest `lowestOpenPosition` any of its stamps stated: every send below it has ended at the sender. */
    endedBelowPosition: number;
    heldBytes: number;
    forgotten: boolean;
    cancelWake: (() => void) | undefined;
    readonly held: Map<number, EdgeOrderHeldMessage<Message>>;
}
