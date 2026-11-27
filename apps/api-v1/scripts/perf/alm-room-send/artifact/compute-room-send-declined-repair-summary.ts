import { computeRoomSendCountByKey } from '../report/compute-room-send-count-by-key.ts';
import { ROOM_SEND_NO_REPAIRS_DECLINED_BY_REASON } from '../report/compute-room-send-stand-in-figures.ts';
import type { RoomSendCellDeclinedRepair } from '../room-send-cell-observations.ts';

/** Every repair a run's stand-ins declined of one send for one reason. */
export interface RoomSendDeclinedRepairsOfSend {
    readonly msgId: string;
    readonly reason: RoomSendCellDeclinedRepair['reason'];
    readonly count: number;
    /** The instants of the first and the last of them, in the order declined. */
    readonly firstAtMs: number;
    readonly lastAtMs: number;
}

/**
 * What an artifact keeps of the repairs a run's stand-ins declined, in place of the list. A track the server stalls
 * draws a decline for each ended send a request asks for, at each execution of each request, so the list grows with
 * the run's requests and not with its sends. Every count is over the whole list, a decline that names no send the
 * cell knows included.
 */
export interface RoomSendDeclinedRepairSummary {
    readonly countByReason: Readonly<Record<RoomSendCellDeclinedRepair['reason'], number>>;
    /** The first declines as recorded, in the order declined, each with its instant; the later ones are left out. */
    readonly firstDeclined: readonly RoomSendCellDeclinedRepair[];
    /** One row for each send and reason, in the order each was first declined. */
    readonly bySendAndReason: readonly RoomSendDeclinedRepairsOfSend[];
}

/** About what a run of the reference shape declines in all; one stalled track of a reference run declined 7,111. */
const DECLINED_REPAIRS_KEPT_AS_RECORDED = 200;

export function computeRoomSendDeclinedRepairSummary(
    declinedRepairs: readonly RoomSendCellDeclinedRepair[]
): RoomSendDeclinedRepairSummary {
    const declinedBySendAndReason = Map.groupBy(
        declinedRepairs,
        (declined) => JSON.stringify([declined.msgId, declined.reason])
    );
    return {
        countByReason: computeRoomSendCountByKey(
            declinedRepairs.map((declined) => declined.reason),
            ROOM_SEND_NO_REPAIRS_DECLINED_BY_REASON
        ),
        firstDeclined: declinedRepairs.slice(0, DECLINED_REPAIRS_KEPT_AS_RECORDED),
        bySendAndReason: [...declinedBySendAndReason.values()].map((declinedOfSend) => ({
            msgId: declinedOfSend[0].msgId,
            reason: declinedOfSend[0].reason,
            count: declinedOfSend.length,
            firstAtMs: declinedOfSend[0].atMs,
            lastAtMs: declinedOfSend[declinedOfSend.length - 1].atMs
        }))
    };
}
