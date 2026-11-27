import { Either } from '../../resilience/Either.ts';

import type { ALReceiptRecordEndedHead, ALReceiptRecordOpenHead } from './al-receipt-record-rows.ts';
import type { ALReceiptRecordTally } from './compute-al-receipt-record-tally.ts';

export interface ALReceiptRecordEndingInput {
    readonly head: ALReceiptRecordOpenHead;
    readonly tally: ALReceiptRecordTally;
    readonly nowMs: number;
}

export function computeALReceiptRecordEnding(
    { head, tally, nowMs }: ALReceiptRecordEndingInput
): Either<'not-due', ALReceiptRecordEndedHead> {
    if (!tally.complete && nowMs < head.opening.deadlineAtMs) {
        return Either.ofLeft('not-due');
    }
    return Either.ofRight({
        phase: tally.complete ? 'complete' : 'timed-out',
        opening: head.opening,
        confirmedRecipientPeerIds: tally.confirmedRecipientPeerIds,
        outsideAudienceRecipientPeerIds: tally.outsideAudienceRecipientPeerIds,
        endedAtEpochMs: nowMs
    });
}
