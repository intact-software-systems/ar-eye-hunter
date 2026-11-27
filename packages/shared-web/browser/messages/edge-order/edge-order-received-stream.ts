import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarMessageOrderGap } from '@shared-web/browser/messages/rallar-message-contracts.ts';

/** Whose stream it is and which channel's: what every gap of the stream names. */
export type EdgeOrderStreamOrigin = Pick<RallarMessageOrderGap, 'topicId' | 'typeId' | 'senderId' | 'stream'>;

/** One key per stream of a page: a sender's stream id is its own, and is kept apart per channel and sender. */
export function toEdgeOrderStreamKey(origin: EdgeOrderStreamOrigin): string {
    return JSON.stringify([origin.topicId, origin.typeId, origin.senderId, origin.stream]);
}

export interface EdgeOrderHeldMessage<Message> {
    readonly stamp: EdgeOrderStamp;
    readonly expiresAtMs: number;
    readonly byteLength: number;
    readonly heldSinceMs: number;
    readonly message: Message;
}

/** One sender's stream as its receiver keeps it. `EdgeOrderReceiver` owns every write. */
export interface EdgeOrderReceivedStream<Message> {
    readonly origin: EdgeOrderStreamOrigin;
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

/** A stream as its first arrival finds it: new, or back at the position the record of its eviction kept. */
export function createEdgeOrderReceivedStream<Message>(
    origin: EdgeOrderStreamOrigin,
    firstSeenAtMs: number,
    nextPosition: number | undefined
): EdgeOrderReceivedStream<Message> {
    return {
        origin,
        firstSeenAtMs,
        nextPosition,
        endedBelowPosition: 0,
        heldBytes: 0,
        forgotten: false,
        cancelWake: undefined,
        held: new Map()
    };
}
