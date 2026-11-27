import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import type { Either } from '@shared/resilience/Either.ts';

import type { RoomSendCellAnswer } from '../room-send-cell-observations.ts';
import { toRoomSendThrownError } from './to-room-send-thrown-error.ts';

/** What came of an offer the entry answered or that threw; `unanswered` is the run's to say, when its observation ends. */
export type RoomSendCellEntryAnswer = Exclude<RoomSendCellAnswer, { readonly acceptance: 'unanswered'; }>;

/** The answer of `acceptIncomingMessage` as the cell records it, read at `answeredAtMs`. */
export function toRoomSendCellAnswer(
    answer: Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>,
    answeredAtMs: number
): RoomSendCellEntryAnswer {
    return answer.fold<RoomSendCellEntryAnswer>(
        (rejection) => ({ acceptance: 'rejected', answeredAtMs, rejectionCode: rejection.code }),
        (acceptance) =>
            acceptance.kind === 'not-admitted'
                ? { acceptance: 'not-admitted', answeredAtMs, notAdmittedReason: acceptance.reason }
                : { acceptance: acceptance.kind, answeredAtMs }
    );
}

/**
 * An offer whose call to `acceptIncomingMessage` threw, as the cell records it, at the instant it threw: the error's
 * name and its message, bounded and with nothing URL-shaped in it (`toRoomSendThrownError`).
 */
export function toRoomSendThrownAnswer(error: Error, answeredAtMs: number): RoomSendCellEntryAnswer {
    return { acceptance: 'threw', answeredAtMs, ...toRoomSendThrownError(error) };
}
