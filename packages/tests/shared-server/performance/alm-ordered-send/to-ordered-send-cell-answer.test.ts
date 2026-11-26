import { describe, expect, it } from 'vitest';

import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import { toOrderedSendCellAnswer } from '../../../../../apps/api-v1/scripts/perf/alm-ordered-send/to-ordered-send-cell-answer.ts';

const ANSWERED_AT_MS = 1_234.5625;

function accepted(
    acceptance: ALInboundMessageRuntime.Acceptance
): Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance> {
    return Either.ofRight(acceptance);
}

describe('toOrderedSendCellAnswer', () => {
    it('answers a rejected send with the code of its rejection and the unrounded instant', () => {
        const rejection = Either.ofLeft<ALMessageRejection, ALInboundMessageRuntime.Acceptance>({
            code: 'unauthorized',
            message: 'WS connection changed during authorization'
        });

        expect(toOrderedSendCellAnswer(rejection, ANSWERED_AT_MS)).toEqual({
            acceptance: 'rejected',
            answeredAtMs: 1_234.5625,
            rejectionCode: 'unauthorized'
        });
    });

    it('answers a send the entry did not admit with the reason the entry gave', () => {
        expect(toOrderedSendCellAnswer(accepted({ kind: 'not-admitted', reason: 'storage-unavailable' }), ANSWERED_AT_MS))
            .toEqual({
                acceptance: 'not-admitted',
                answeredAtMs: 1_234.5625,
                notAdmittedReason: 'storage-unavailable'
            });
    });

    it.each(
        [
            'admitted',
            'duplicate',
            'resync-required',
            'disposed',
            'pending-admission'
        ] as const
    )('answers a send the entry accepted as %s with that kind alone', (kind) => {
        expect(toOrderedSendCellAnswer(accepted({ kind }), ANSWERED_AT_MS))
            .toEqual({ acceptance: kind, answeredAtMs: 1_234.5625 });
    });

    it('answers a send the entry took for a control as a control, without its handled flag', () => {
        expect(toOrderedSendCellAnswer(accepted({ kind: 'control', handled: false }), ANSWERED_AT_MS))
            .toEqual({ acceptance: 'control', answeredAtMs: 1_234.5625 });
    });
});
