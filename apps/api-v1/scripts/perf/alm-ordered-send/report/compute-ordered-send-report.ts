import type { OrderedSendCellObservations } from '../ordered-send-cell-observations.ts';
import {
    computeOrderedSendBeforeFirstControlFigures,
    type OrderedSendBeforeFirstControlFigures
} from './compute-ordered-send-before-first-control-figures.ts';
import {
    computeOrderedSendControlFigures,
    type OrderedSendControlFigures
} from './compute-ordered-send-control-figures.ts';
import {
    computeOrderedSendDeliveryFigures,
    type OrderedSendDeliveryFigures
} from './compute-ordered-send-delivery-figures.ts';
import {
    computeOrderedSendReceiptFigures,
    type OrderedSendReceiptFigures
} from './compute-ordered-send-receipt-figures.ts';
import {
    computeOrderedSendRecipientDelayFigures,
    type OrderedSendRecipientDelayFigures
} from './compute-ordered-send-recipient-delay-figures.ts';
import {
    computeOrderedSendResendFigures,
    type OrderedSendResendFigures
} from './compute-ordered-send-resend-figures.ts';
import {
    computeOrderedSendSendFigures,
    type OrderedSendSendFigures
} from './compute-ordered-send-send-figures.ts';
import {
    computeOrderedSendUnmatchedFigures,
    type OrderedSendUnmatchedFigures
} from './compute-ordered-send-unmatched-figures.ts';
import { toObservedOrderedSends } from './to-observed-ordered-sends.ts';

/**
 * Every figure of one run of the cell. A send is the first in the list to carry its msgId, and what the cell recorded
 * beside the sends it knows is counted in `unmatched`, never dropped.
 */
export interface OrderedSendReport {
    readonly sends: OrderedSendSendFigures;
    readonly delivery: OrderedSendDeliveryFigures;
    readonly recipientDelays: OrderedSendRecipientDelayFigures;
    readonly receipts: OrderedSendReceiptFigures;
    readonly controls: OrderedSendControlFigures;
    readonly beforeFirstControl: OrderedSendBeforeFirstControlFigures;
    readonly resends: OrderedSendResendFigures;
    readonly unmatched: OrderedSendUnmatchedFigures;
}

export function computeOrderedSendReport(observations: OrderedSendCellObservations): OrderedSendReport {
    const observedSends = toObservedOrderedSends(observations);
    return {
        sends: computeOrderedSendSendFigures(observedSends.map(({ send }) => send)),
        delivery: computeOrderedSendDeliveryFigures(observedSends),
        recipientDelays: computeOrderedSendRecipientDelayFigures(observedSends),
        receipts: computeOrderedSendReceiptFigures(observedSends),
        controls: computeOrderedSendControlFigures(observedSends),
        beforeFirstControl: computeOrderedSendBeforeFirstControlFigures(observedSends),
        resends: computeOrderedSendResendFigures(observedSends),
        unmatched: computeOrderedSendUnmatchedFigures(observations)
    };
}
