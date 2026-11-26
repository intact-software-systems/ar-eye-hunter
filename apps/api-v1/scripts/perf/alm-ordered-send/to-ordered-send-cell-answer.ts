import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { OrderedSendCellAnswer } from './ordered-send-cell-observations.ts';
import { toOrderedSendThrownError } from './to-ordered-send-thrown-error.ts';

/** What came of an offer the entry answered or that threw; `unanswered` is the run's to say, when its observation ends. */
export type OrderedSendCellEntryAnswer = Exclude<OrderedSendCellAnswer, { readonly acceptance: 'unanswered'; }>;

/** The answer of `acceptIncomingMessage` as the cell records it, read at `answeredAtMs`. */
export function toOrderedSendCellAnswer(
    answer: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>,
    answeredAtMs: number
): OrderedSendCellEntryAnswer {
    return answer.fold<OrderedSendCellEntryAnswer>(
        (rejection) => ({ acceptance: 'rejected', answeredAtMs, rejectionCode: rejection.code }),
        (acceptance) => {
            switch (acceptance.kind) {
                case 'not-admitted':
                    return { acceptance: 'not-admitted', answeredAtMs, notAdmittedReason: acceptance.reason };
                case 'control':
                    return { acceptance: 'control', answeredAtMs, handled: acceptance.handled };
                default:
                    return { acceptance: acceptance.kind, answeredAtMs };
            }
        }
    );
}

/**
 * An offer whose call to `acceptIncomingMessage` threw, as the cell records it, at the instant it threw: the error's
 * name and its message, bounded and with nothing URL-shaped in it (`toOrderedSendThrownError`).
 */
export function toOrderedSendThrownAnswer(error: Error, answeredAtMs: number): OrderedSendCellEntryAnswer {
    return { acceptance: 'threw', answeredAtMs, ...toOrderedSendThrownError(error) };
}
