export type EdgeOrderGapReason =
    | 'ended-at-sender'
    | 'cannot-arrive'
    | 'held-message-deadline'
    | 'channel-wait-cap'
    | 'held-message-cap'
    | 'held-byte-cap'
    | 'stream-cap';

/** The positions `fromPosition` to `toPosition` of one stream, both included, that its receiver stopped waiting for. */
export interface EdgeOrderGap {
    readonly senderId: string;
    readonly streamId: string;
    readonly fromPosition: number;
    readonly toPosition: number;
    readonly reason: EdgeOrderGapReason;
}
