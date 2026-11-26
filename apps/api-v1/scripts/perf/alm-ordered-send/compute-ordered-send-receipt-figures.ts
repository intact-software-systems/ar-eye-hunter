import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';

import { computeOrderedSendDelaySummary, type OrderedSendDelaySummary } from './compute-ordered-send-delay-summary.ts';
import type { OrderedSendCellReceipt, OrderedSendCellSend } from './ordered-send-cell-observations.ts';
import type { ObservedOrderedSend } from './to-observed-ordered-sends.ts';

/**
 * What the publishers read of their receipts. A receipt is expected of a send the entry answered `admitted` or
 * `pending-admission`, and every figure here is over those sends only; the others are in `sends.byAcceptance`.
 */
export interface OrderedSendReceiptFigures {
    /** The sends a receipt is expected of; the next four counts split them, one state each. */
    readonly expected: number;
    /** Sends whose first terminal receipt read `complete`. */
    readonly complete: number;
    /** Sends whose first terminal receipt read `timed-out`. */
    readonly timedOut: number;
    /** Sends that read an `admitted` receipt and no terminal one before observation stopped. */
    readonly admittedWithoutTerminal: number;
    /** Sends that read no receipt at all. */
    readonly noReceipt: number;
    /** Sends that read a second terminal receipt; each is also in `complete` or `timedOut`, under its first. */
    readonly moreThanOneTerminal: number;
    /** Every send that read an `admitted` receipt, from its offer at the entry to the first one. */
    readonly offerToAdmittedMs: OrderedSendDelaySummary;
    /** Every send counted `complete`, from its offer at the entry to that receipt. */
    readonly offerToCompleteMs: OrderedSendDelaySummary;
    /** Every send counted `timedOut`, from its offer at the entry to that receipt. */
    readonly offerToTimedOutMs: OrderedSendDelaySummary;
}

type OrderedSendReceiptState = 'complete' | 'timedOut' | 'admittedWithoutTerminal' | 'noReceipt';

/** Where a send stands once it has read a receipt of the phase; a phase added to the contract has no key here. */
const ORDERED_SEND_RECEIPT_STATE_BY_PHASE: Readonly<
    Record<ALReceiptPayload['phase'], Exclude<OrderedSendReceiptState, 'noReceipt'>>
> = {
    admitted: 'admittedWithoutTerminal',
    complete: 'complete',
    'timed-out': 'timedOut'
};

export function computeOrderedSendReceiptFigures(
    observedSends: readonly ObservedOrderedSend[]
): OrderedSendReceiptFigures {
    const expected = observedSends.filter(({ send }) => isOrderedSendReceiptExpected(send));
    const expectedByState = Map.groupBy(expected, ({ receipts }) => resolveOrderedSendReceiptState(receipts));
    const complete = expectedByState.get('complete') ?? [];
    const timedOut = expectedByState.get('timedOut') ?? [];
    return {
        expected: expected.length,
        complete: complete.length,
        timedOut: timedOut.length,
        admittedWithoutTerminal: expectedByState.get('admittedWithoutTerminal')?.length ?? 0,
        noReceipt: expectedByState.get('noReceipt')?.length ?? 0,
        moreThanOneTerminal: expected.filter(({ receipts }) => receipts.filter(isTerminal).length > 1).length,
        offerToAdmittedMs: computeOrderedSendDelaySummary(computeOfferToFirstReceiptMs(expected, 'admitted')),
        offerToCompleteMs: computeOrderedSendDelaySummary(computeOfferToFirstReceiptMs(complete, 'complete')),
        offerToTimedOutMs: computeOrderedSendDelaySummary(computeOfferToFirstReceiptMs(timedOut, 'timed-out'))
    };
}

export function isOrderedSendReceiptExpected(send: OrderedSendCellSend): boolean {
    return send.acceptance === 'admitted' || send.acceptance === 'pending-admission';
}

function isTerminal(receipt: OrderedSendCellReceipt): boolean {
    return ORDERED_SEND_RECEIPT_STATE_BY_PHASE[receipt.phase] !== 'admittedWithoutTerminal';
}

/** The first terminal receipt decides; `receipts` is in the order the publisher read them. */
function resolveOrderedSendReceiptState(receipts: readonly OrderedSendCellReceipt[]): OrderedSendReceiptState {
    const decidingReceipt = receipts.find(isTerminal) ?? receipts.at(0);
    return decidingReceipt === undefined ? 'noReceipt' : ORDERED_SEND_RECEIPT_STATE_BY_PHASE[decidingReceipt.phase];
}

function computeOfferToFirstReceiptMs(
    observedSends: readonly ObservedOrderedSend[],
    phase: ALReceiptPayload['phase']
): readonly number[] {
    return observedSends.flatMap(({ send, receipts }) =>
        receipts.filter((receipt) => receipt.phase === phase).slice(0, 1).map(({ atMs }) => atMs - send.sentAtMs)
    );
}
