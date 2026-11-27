import type { RoomSendCellDeclinedRepair, RoomSendCellSendEnd } from '../room-send-cell-observations.ts';
import { computeRoomSendCountByKey } from './compute-room-send-count-by-key.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * What the publishers' stand-ins ended and declined, under the sender recovery `client-stand-in`; every count is 0
 * under `none`. Every count is over the ends and the declined repairs that name a send the cell knows; one that names
 * no send is in `unmatched`. A send has at most one end, so the causes add up to `sendsEnded`. A cause or a reason
 * added to the contract has no key here, and fails to compile.
 */
export interface RoomSendStandInFigures {
    /** Sends a stand-in ended: it offered each again for no cause from then on. */
    readonly sendsEnded: number;
    readonly endsByCause: Readonly<Record<RoomSendCellSendEnd['cause'], number>>;
    /** Re-offers a repair request asked for that a stand-in did not make, for an ended or expired send. */
    readonly repairsDeclined: number;
    readonly repairsDeclinedByReason: Readonly<Record<RoomSendCellDeclinedRepair['reason'], number>>;
}

/** No repair declined, under every reason there is: what a count of declined repairs by reason starts from. */
export const ROOM_SEND_NO_REPAIRS_DECLINED_BY_REASON: RoomSendStandInFigures['repairsDeclinedByReason'] = {
    'send-ended': 0,
    'send-expired': 0,
    'named-send-expired': 0
};

const NO_ENDS_BY_CAUSE: RoomSendStandInFigures['endsByCause'] = {
    'first-hop-exhausted': 0,
    'terminal-receipt': 0,
    'terminal-nack': 0,
    'repair-budget-spent': 0,
    expired: 0
};

export function computeRoomSendStandInFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendStandInFigures {
    const declinedRepairs = observedSends.flatMap((observed) => observed.declinedRepairs);
    return {
        sendsEnded: observedSends.filter((observed) => observed.sendEnds.length > 0).length,
        endsByCause: computeRoomSendCountByKey(
            observedSends.flatMap((observed) => observed.sendEnds.map((end) => end.cause)),
            NO_ENDS_BY_CAUSE
        ),
        repairsDeclined: declinedRepairs.length,
        repairsDeclinedByReason: computeRoomSendCountByKey(
            declinedRepairs.map((declined) => declined.reason),
            ROOM_SEND_NO_REPAIRS_DECLINED_BY_REASON
        )
    };
}
