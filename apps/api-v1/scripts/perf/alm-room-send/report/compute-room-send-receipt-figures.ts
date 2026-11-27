import type { ALReceiptPayload } from '@shared/al-contracts/al-control.ts';

import type { RoomSendCellReceipt, RoomSendCellSend } from '../room-send-cell-observations.ts';
import { computeRoomSendDelaySummary, type RoomSendDelaySummary } from './compute-room-send-delay-summary.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * What the publishers read of their receipts. A receipt is expected of a send whose first offer the entry answered
 * `admitted` or `pending-admission`, and every figure here is over those sends only; the others are in
 * `sends.byAcceptance`. Every delay is from that first offer, whatever was offered again. A
 * publisher may read one receipt more than once: a send's state and each of its delays come from the first read of
 * the phase, and `moreThanOneTerminal`, `sendsWithARepeatedAdmittedReceipt` and
 * `sendsWithAnAdmittedAfterTheirTerminal` count the sends that read one again, each of them in one of the four
 * states as well.
 */
export interface RoomSendReceiptFigures {
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
    /**
     * Sends that read a second terminal receipt, of the same phase or of the other; each is also in `complete` or
     * `timedOut`, under its first.
     */
    readonly moreThanOneTerminal: number;
    /** Sends that read more than one `admitted` receipt. */
    readonly sendsWithARepeatedAdmittedReceipt: number;
    /** Sends that read an `admitted` receipt after their first terminal one, in the order they read them. */
    readonly sendsWithAnAdmittedAfterTheirTerminal: number;
    /** Every send that read an `admitted` receipt, from its offer at the entry to the first one. */
    readonly offerToAdmittedMs: RoomSendDelaySummary;
    /** Every send counted `complete`, from its offer at the entry to that receipt. */
    readonly offerToCompleteMs: RoomSendDelaySummary;
    /** Every send counted `timedOut`, from its offer at the entry to that receipt. */
    readonly offerToTimedOutMs: RoomSendDelaySummary;
}

type RoomSendReceiptState = 'complete' | 'timedOut' | 'admittedWithoutTerminal' | 'noReceipt';

/** Where a send stands once it has read a receipt of the phase; a phase added to the contract has no key here. */
const ROOM_SEND_RECEIPT_STATE_BY_PHASE: Readonly<
    Record<ALReceiptPayload['phase'], Exclude<RoomSendReceiptState, 'noReceipt'>>
> = {
    admitted: 'admittedWithoutTerminal',
    complete: 'complete',
    'timed-out': 'timedOut'
};

export function computeRoomSendReceiptFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendReceiptFigures {
    const expected = observedSends.filter(({ send }) => isRoomSendReceiptExpected(send));
    const expectedByState = Map.groupBy(expected, ({ receipts }) => resolveRoomSendReceiptState(receipts));
    const complete = expectedByState.get('complete') ?? [];
    const timedOut = expectedByState.get('timedOut') ?? [];
    return {
        expected: expected.length,
        complete: complete.length,
        timedOut: timedOut.length,
        admittedWithoutTerminal: expectedByState.get('admittedWithoutTerminal')?.length ?? 0,
        noReceipt: expectedByState.get('noReceipt')?.length ?? 0,
        moreThanOneTerminal: expected.filter(({ receipts }) => receipts.filter(isTerminal).length > 1).length,
        sendsWithARepeatedAdmittedReceipt: expected
            .filter(({ receipts }) => receipts.filter((receipt) => !isTerminal(receipt)).length > 1).length,
        sendsWithAnAdmittedAfterTheirTerminal: expected
            .filter(({ receipts }) => isAdmittedReadAfterFirstTerminal(receipts)).length,
        offerToAdmittedMs: computeRoomSendDelaySummary(computeOfferToFirstReceiptMs(expected, 'admitted')),
        offerToCompleteMs: computeRoomSendDelaySummary(computeOfferToFirstReceiptMs(complete, 'complete')),
        offerToTimedOutMs: computeRoomSendDelaySummary(computeOfferToFirstReceiptMs(timedOut, 'timed-out'))
    };
}

export function isRoomSendReceiptExpected(send: RoomSendCellSend): boolean {
    return send.acceptance === 'admitted' || send.acceptance === 'pending-admission';
}

function isTerminal(receipt: RoomSendCellReceipt): boolean {
    return ROOM_SEND_RECEIPT_STATE_BY_PHASE[receipt.phase] !== 'admittedWithoutTerminal';
}

function isAdmittedReadAfterFirstTerminal(receipts: readonly RoomSendCellReceipt[]): boolean {
    const firstTerminalPosition = receipts.findIndex(isTerminal);
    return firstTerminalPosition !== -1 &&
        receipts.slice(firstTerminalPosition + 1).some((receipt) => !isTerminal(receipt));
}

/** The first terminal receipt decides; `receipts` is in the order the publisher read them. */
function resolveRoomSendReceiptState(receipts: readonly RoomSendCellReceipt[]): RoomSendReceiptState {
    const decidingReceipt = receipts.find(isTerminal) ?? receipts.at(0);
    return decidingReceipt === undefined ? 'noReceipt' : ROOM_SEND_RECEIPT_STATE_BY_PHASE[decidingReceipt.phase];
}

function computeOfferToFirstReceiptMs(
    observedSends: readonly ObservedRoomSend[],
    phase: ALReceiptPayload['phase']
): readonly number[] {
    return observedSends.flatMap(({ send, receipts }) =>
        receipts.filter((receipt) => receipt.phase === phase).slice(0, 1).map(({ atMs }) => atMs - send.sentAtMs)
    );
}
