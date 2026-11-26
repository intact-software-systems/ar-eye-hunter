/** A run of neighbouring positions of one stream, both ends included. */
export type EdgeOrderPositionRun = readonly [fromPosition: number, toPosition: number];

/**
 * The most runs of holes one stamp states. A stream with more of them between its lowest open send and the stamped
 * one states the lowest: a receiver reaches those first, and a later stamp states the next ones once these are passed.
 */
export const EDGE_ORDER_MAX_STATED_HOLES = 16;

/**
 * What a sender states on each message of an edge-ordered stream. `stream` is minted in memory once per sender page
 * and stream, never from the session id, which a reload keeps and every tab of a login shares. Positions count from
 * 1. Every send below `lowestOpenPosition` has ended at the sender, and no copy of an earlier send is worth waiting
 * for after `earlierCanArriveUntilMs`, which is absent when nothing retries any earlier open send.
 *
 * `holes` are the positions between `lowestOpenPosition` and `position` of which no copy can be handed over any
 * more: the send never set out, was refused or cancelled, or is past its deadline. A send every recipient acknowledged
 * is no hole: a recipient has it, and may not have sorted it yet. The runs rise, do not touch, and number at most
 * `EDGE_ORDER_MAX_STATED_HOLES`. Whoever decodes a stamp checks all of this.
 */
export interface EdgeOrderStamp {
    readonly stream: string;
    readonly position: number;
    readonly lowestOpenPosition: number;
    readonly earlierCanArriveUntilMs: number | undefined;
    readonly holes: readonly EdgeOrderPositionRun[];
}
