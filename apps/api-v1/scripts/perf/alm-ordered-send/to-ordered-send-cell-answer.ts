import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { OrderedSendCellAnswer } from './ordered-send-cell-observations.ts';

/** What the entry answered a send it answered at all; `unanswered` is the run's to say, when its observation ends. */
export type OrderedSendCellEntryAnswer = Exclude<OrderedSendCellAnswer, { readonly acceptance: 'unanswered'; }>;

/** The answer of `acceptIncomingMessage` as the cell records it, read at `answeredAtMs`. */
export function toOrderedSendCellAnswer(
    answer: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>,
    answeredAtMs: number
): OrderedSendCellEntryAnswer {
    return answer.fold<OrderedSendCellEntryAnswer>(
        (rejection) => ({ acceptance: 'rejected', answeredAtMs, rejectionCode: rejection.code }),
        (acceptance) =>
            acceptance.kind === 'not-admitted'
                ? { acceptance: 'not-admitted', answeredAtMs, notAdmittedReason: acceptance.reason }
                : { acceptance: acceptance.kind, answeredAtMs }
    );
}
