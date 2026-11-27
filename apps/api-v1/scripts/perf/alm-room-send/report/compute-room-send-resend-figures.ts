import { computeNumberExtrema } from '@shared/measurement/compute-number-extrema.ts';

import type { RoomSendCellResend } from '../room-send-cell-observations.ts';
import {
    computeRoomSendAnswerFigures,
    type RoomSendAnswerFigures
} from './compute-room-send-answer-figures.ts';
import type { ObservedRoomSend } from './to-observed-room-sends.ts';

/**
 * Some later offers of sends: how many, what came of them, and how many sends they were of. Each count by answer is
 * of what came of the later offer, never of the send's first one.
 */
export interface RoomSendResendCounts extends RoomSendAnswerFigures {
    readonly count: number;
    /** Sends offered again at least once. */
    readonly sendsResent: number;
}

export interface RoomSendResendCauseFigures extends RoomSendResendCounts {
    /** The most later offers of this cause any one send had; null when none had one. */
    readonly largestAttempt: number | null;
}

/**
 * What the publishers offered again, under the sender recovery `client-stand-in`; every count is 0 under `none`.
 * Every count is over the later offers that name a send the cell knows; one that names no send is in `unmatched`. A
 * later offer is no send: `sends` counts each send once, by its first offer, and every delay of the report is
 * measured from that first offer or from the send's due time, never from a later offer. A cause added to the
 * contract has no key here, and fails to compile.
 */
export interface RoomSendResendFigures extends RoomSendResendCounts {
    readonly byCause: Readonly<Record<RoomSendCellResend['cause'], RoomSendResendCauseFigures>>;
}

export function computeRoomSendResendFigures(
    observedSends: readonly ObservedRoomSend[]
): RoomSendResendFigures {
    const resendsBySend = observedSends.map(({ resends }) => resends);
    return {
        ...computeResendCounts(resendsBySend),
        byCause: {
            repair: computeResendCauseFigures(resendsBySend, 'repair'),
            'first-hop': computeResendCauseFigures(resendsBySend, 'first-hop')
        }
    };
}

function computeResendCauseFigures(
    resendsBySend: readonly (readonly RoomSendCellResend[])[],
    cause: RoomSendCellResend['cause']
): RoomSendResendCauseFigures {
    const resendsOfCauseBySend = resendsBySend.map((resends) => resends.filter((resend) => resend.cause === cause));
    return {
        ...computeResendCounts(resendsOfCauseBySend),
        largestAttempt: computeNumberExtrema(resendsOfCauseBySend.flat().map((resend) => resend.attempt))?.max ?? null
    };
}

function computeResendCounts(resendsBySend: readonly (readonly RoomSendCellResend[])[]): RoomSendResendCounts {
    const resends = resendsBySend.flat();
    return {
        count: resends.length,
        ...computeRoomSendAnswerFigures(resends),
        sendsResent: resendsBySend.filter((resendsOfSend) => resendsOfSend.length > 0).length
    };
}
