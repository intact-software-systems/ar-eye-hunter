import type { ALNackReason, ALRepairReason } from '@shared/al-contracts/al-control.ts';

import { computeOrderedSendCountByKey } from './compute-ordered-send-count-by-key.ts';
import type { OrderedSendCellControl } from './ordered-send-cell-observations.ts';
import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * What the server told the sessions about the sends beside their receipts: its NACKs and its repair requests. Every
 * count is over the controls that name a send the cell knows; a control that names no send is in `unmatched`. A
 * control about a gap names the send whose arrival showed the gap, so that send is the one counted, never a missing
 * one. A reason added to either contract has no key here, and fails to compile.
 */
export interface OrderedSendControlFigures {
    readonly byType: Readonly<Record<OrderedSendCellControl['type'], number>>;
    /** The NACKs, by the reason each gave. */
    readonly nacksByReason: Readonly<Record<ALNackReason, number>>;
    /** The repair requests, by the reason each gave. */
    readonly repairsByReason: Readonly<Record<ALRepairReason, number>>;
    /** Sends at least one NACK named. */
    readonly sendsWithANack: number;
    /** Sends at least one repair request named. */
    readonly sendsWithARepairRequest: number;
}

const NO_CONTROLS_BY_TYPE: OrderedSendControlFigures['byType'] = { nack: 0, repair: 0 };

const NO_NACKS_BY_REASON: OrderedSendControlFigures['nacksByReason'] = {
    duplicate: 0,
    gap: 0,
    'resync-required': 0,
    expired: 0,
    unauthorized: 0,
    'no-route': 0,
    overloaded: 0,
    stale: 0,
    'not-yet-in-sync': 0,
    'membership-fenced': 0,
    'no-leader': 0,
    'held-by-other': 0,
    unsupported: 0,
    'no-publish-grant': 0,
    'not-subscribed': 0,
    'before-entry': 0
};

const NO_REPAIRS_BY_REASON: OrderedSendControlFigures['repairsByReason'] = {
    'missing-seq': 0,
    retransmit: 0,
    resync: 0
};

export function computeOrderedSendControlFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendControlFigures {
    const controls = observedSends.flatMap((observed) => observed.controls);
    return {
        byType: computeOrderedSendCountByKey(controls.map((control) => control.type), NO_CONTROLS_BY_TYPE),
        nacksByReason: computeOrderedSendCountByKey(
            controls.flatMap((control) => control.type === 'nack' ? [control.reason] : []),
            NO_NACKS_BY_REASON
        ),
        repairsByReason: computeOrderedSendCountByKey(
            controls.flatMap((control) => control.type === 'repair' ? [control.reason] : []),
            NO_REPAIRS_BY_REASON
        ),
        sendsWithANack: observedSends
            .filter((observed) => observed.controls.some((control) => control.type === 'nack')).length,
        sendsWithARepairRequest: observedSends
            .filter((observed) => observed.controls.some((control) => control.type === 'repair')).length
    };
}
