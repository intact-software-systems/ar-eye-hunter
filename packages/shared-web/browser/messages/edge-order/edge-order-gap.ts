export type EdgeOrderGapReason =
    | 'ended-at-sender'
    | 'cannot-arrive'
    | 'held-message-deadline'
    | 'held-message-expired'
    | 'channel-wait-cap'
    | 'held-message-cap'
    | 'held-byte-cap'
    | 'stream-cap';

/**
 * The positions `fromPosition` to `toPosition` of one stream, both included, that its receiver did not hand over:
 * it stopped waiting for them, or, as `held-message-expired`, it held the message until after its own deadline.
 */
export interface EdgeOrderGap {
    readonly senderId: string;
    readonly stream: string;
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly reason: EdgeOrderGapReason;
}
