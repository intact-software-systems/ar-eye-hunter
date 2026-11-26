/**
 * What a sender states on each message of an edge-ordered stream. Positions count from 1. Every send below
 * `lowestOpenPosition` has ended at the sender, and no copy of an earlier send is worth waiting for after
 * `earlierCanArriveUntilMs`, which is absent when nothing retries any earlier open send.
 */
export interface EdgeOrderStamp {
    readonly streamId: string;
    readonly position: number;
    readonly lowestOpenPosition: number;
    readonly earlierCanArriveUntilMs: number | undefined;
}
