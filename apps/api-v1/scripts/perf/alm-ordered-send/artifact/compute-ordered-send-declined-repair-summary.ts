import type { OrderedSendCellDeclinedRepair } from '../ordered-send-cell-observations.ts';
import { computeOrderedSendCountByKey } from '../report/compute-ordered-send-count-by-key.ts';
import { ORDERED_SEND_NO_REPAIRS_DECLINED_BY_REASON } from '../report/compute-ordered-send-stand-in-figures.ts';

/** Every repair a run's stand-ins declined of one send for one reason. */
export interface OrderedSendDeclinedRepairsOfSend {
    readonly msgId: string;
    readonly reason: OrderedSendCellDeclinedRepair['reason'];
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
export interface OrderedSendDeclinedRepairSummary {
    readonly countByReason: Readonly<Record<OrderedSendCellDeclinedRepair['reason'], number>>;
    /** The first declines as recorded, in the order declined, each with its instant; the later ones are left out. */
    readonly firstDeclined: readonly OrderedSendCellDeclinedRepair[];
    /** One row for each send and reason, in the order each was first declined. */
    readonly bySendAndReason: readonly OrderedSendDeclinedRepairsOfSend[];
}

/** About what a run of the reference shape declines in all; one stalled track of a reference run declined 7,111. */
const DECLINED_REPAIRS_KEPT_AS_RECORDED = 200;

export function computeOrderedSendDeclinedRepairSummary(
    declinedRepairs: readonly OrderedSendCellDeclinedRepair[]
): OrderedSendDeclinedRepairSummary {
    const declinedBySendAndReason = Map.groupBy(
        declinedRepairs,
        (declined) => JSON.stringify([declined.msgId, declined.reason])
    );
    return {
        countByReason: computeOrderedSendCountByKey(
            declinedRepairs.map((declined) => declined.reason),
            ORDERED_SEND_NO_REPAIRS_DECLINED_BY_REASON
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
