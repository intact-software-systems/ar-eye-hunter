/**
 * How long a page waits for the messages of one stream, as the stream's channel declared it on that page: the two
 * waits a channel may set. Each arrival carries the waits that stand for its channel then.
 */
export interface EdgeOrderStreamWaits {
    /** How long a stream first seen past its start waits for earlier messages before it starts. */
    readonly orderEntryWindowMs: number;
    /** The longest a message is held for order; absent when only its sender's statement bounds the wait. */
    readonly orderGapWaitMs: number | undefined;
}

export const EDGE_ORDER_DEFAULT_STREAM_WAITS: EdgeOrderStreamWaits = {
    orderEntryWindowMs: 500,
    orderGapWaitMs: undefined
};
