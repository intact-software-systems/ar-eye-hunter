import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    toOrderedSendCellAnswer,
    toOrderedSendThrownAnswer,
    type OrderedSendCellEntryAnswer
} from './to-ordered-send-cell-answer.ts';

/**
 * Makes one offer at the server's entry, at once, and reads what came of it at the instant it came: the entry's
 * answer, or that the offer threw. It never rejects: an offer that throws is an observation of the run, as its answer
 * would have been, and the run goes on.
 */
export async function readOrderedSendCellAnswer(
    offer: () => Promise<Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>>,
    nowMs: () => number
): Promise<OrderedSendCellEntryAnswer> {
    try {
        return toOrderedSendCellAnswer(await offer(), nowMs());
    }
    catch (thrown) {
        return toOrderedSendThrownAnswer(toError(thrown), nowMs());
    }
}
