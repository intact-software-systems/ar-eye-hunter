import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';

import type { RoomSendCellAnswer } from '../room-send-cell-observations.ts';
import { computeRoomSendCountByKey } from './compute-room-send-count-by-key.ts';

/** What came of some offers at the server's entry: of first offers of sends, of later ones, or of ACKs. */
export interface RoomSendAnswerFigures {
    /** By what came of each offer: `threw` is an offer that threw, `unanswered` one pending when observation ended. */
    readonly byAcceptance: Readonly<Record<RoomSendCellAnswer['acceptance'], number>>;
    /** The `rejected` offers, by the code of their rejection. */
    readonly rejectedByCode: Readonly<Record<ALMessageRejection['code'], number>>;
    /** The `not-admitted` offers, by the reason the entry gave; a reason no offer was refused for has no key. */
    readonly notAdmittedByReason: Readonly<Record<string, number>>;
    /** The offers that threw, by the name of the error; a name no offer threw has no key. */
    readonly threwByErrorName: Readonly<Record<string, number>>;
    /** Under each of those names, the message of the first offer in the list that threw it. */
    readonly firstThrownMessageByErrorName: Readonly<Record<string, string>>;
}

/** Every answer an offer can have, each at 0: an answer added to the contract has no key here, and fails to compile. */
const NO_OFFERS_BY_ACCEPTANCE: RoomSendAnswerFigures['byAcceptance'] = {
    admitted: 0,
    duplicate: 0,
    'resync-required': 0,
    disposed: 0,
    'pending-admission': 0,
    'not-admitted': 0,
    control: 0,
    rejected: 0,
    threw: 0,
    unanswered: 0
};

const NO_OFFERS_BY_REJECTION_CODE: RoomSendAnswerFigures['rejectedByCode'] = {
    malformed: 0,
    oversized: 0,
    unauthorized: 0,
    unsupported: 0
};

export function computeRoomSendAnswerFigures(answers: readonly RoomSendCellAnswer[]): RoomSendAnswerFigures {
    const thrown = answers.flatMap((answer) => answer.acceptance === 'threw' ? [answer] : []);
    return {
        byAcceptance: computeRoomSendCountByKey(answers.map((answer) => answer.acceptance), NO_OFFERS_BY_ACCEPTANCE),
        rejectedByCode: computeRoomSendCountByKey(
            answers.flatMap((answer) => answer.acceptance === 'rejected' ? [answer.rejectionCode] : []),
            NO_OFFERS_BY_REJECTION_CODE
        ),
        notAdmittedByReason: computeRoomSendCountByKey(
            answers.flatMap((answer) => answer.acceptance === 'not-admitted' ? [answer.notAdmittedReason] : []),
            {}
        ),
        threwByErrorName: computeRoomSendCountByKey(thrown.map((answer) => answer.errorName), {}),
        firstThrownMessageByErrorName: thrown.reduce<Readonly<Record<string, string>>>(
            (messages, answer) =>
                Object.hasOwn(messages, answer.errorName)
                    ? messages
                    : { ...messages, [answer.errorName]: answer.errorMessage },
            {}
        )
    };
}
