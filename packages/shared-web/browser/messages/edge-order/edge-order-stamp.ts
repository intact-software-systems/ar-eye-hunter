/**
 * What a sender states on each message of an edge-ordered stream. `stream` is minted in memory once per sender page
 * and stream, never from the session id, which a reload keeps and every tab of a login shares. Positions count from
 * 1. Every send below `lowestOpenPosition` has ended at the sender, and no copy of an earlier send is worth waiting
 * for after `earlierCanArriveUntilMs`, which is absent when nothing retries any earlier open send. Whoever decodes a
 * stamp checks that both positions are whole numbers from 1 and that the lowest open one is not above the other.
 */
export interface EdgeOrderStamp {
    readonly stream: string;
    readonly position: number;
    readonly lowestOpenPosition: number;
    readonly earlierCanArriveUntilMs: number | undefined;
}
