import { describe, expect, it } from 'vitest';

import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    toRoomSendCellAnswer,
    toRoomSendThrownAnswer
} from '../../../../../../apps/api-v1/scripts/perf/alm-room-send/answer/to-room-send-cell-answer.ts';

const ANSWERED_AT_MS = 1_234.5625;

function accepted(
    acceptance: ALInboundMessageRuntime.Acceptance
): Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance> {
    return Either.ofRight(acceptance);
}

describe('toRoomSendCellAnswer', () => {
    it('answers a rejected send with the code of its rejection and the unrounded instant', () => {
        const rejection = Either.ofLeft<ALMessageRejection, ALInboundMessageRuntime.Acceptance>({
            code: 'unauthorized',
            message: 'WS connection changed during authorization'
        });

        expect(toRoomSendCellAnswer(rejection, ANSWERED_AT_MS)).toEqual({
            acceptance: 'rejected',
            answeredAtMs: 1_234.5625,
            rejectionCode: 'unauthorized'
        });
    });

    it('answers a send the entry did not admit with the reason the entry gave', () => {
        expect(toRoomSendCellAnswer(accepted({ kind: 'not-admitted', reason: 'storage-unavailable' }), ANSWERED_AT_MS))
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
        expect(toRoomSendCellAnswer(accepted({ kind }), ANSWERED_AT_MS))
            .toEqual({ acceptance: kind, answeredAtMs: 1_234.5625 });
    });

    it('answers an offer the entry took for a control as a control, without the flag that says nothing of an ACK', () => {
        expect(toRoomSendCellAnswer(accepted({ kind: 'control', handled: false }), ANSWERED_AT_MS))
            .toEqual({ acceptance: 'control', answeredAtMs: 1_234.5625 });
        expect(toRoomSendCellAnswer(accepted({ kind: 'control', handled: true }), ANSWERED_AT_MS))
            .toEqual({ acceptance: 'control', answeredAtMs: 1_234.5625 });
    });
});

describe('toRoomSendThrownAnswer', () => {
    it('answers an offer that threw with the error\'s name, its message and the unrounded instant it threw at', () => {
        const error = new Error('Buffered inbound ordering slot lost its canonical message');
        error.name = 'ALAdmissionCorruptionError';

        expect(toRoomSendThrownAnswer(error, ANSWERED_AT_MS)).toEqual({
            acceptance: 'threw',
            answeredAtMs: 1_234.5625,
            errorName: 'ALAdmissionCorruptionError',
            errorMessage: 'Buffered inbound ordering slot lost its canonical message'
        });
    });

    it('records at most 240 characters of the message, and no URL of it', () => {
        const error = new Error(`connect postgres://app:s3cr3t@db.internal:5432/run refused ${'x'.repeat(300)}`);

        const answer = toRoomSendThrownAnswer(error, ANSWERED_AT_MS);

        expect(answer).toEqual({
            acceptance: 'threw',
            answeredAtMs: 1_234.5625,
            errorName: 'Error',
            errorMessage: `connect <url removed> refused ${'x'.repeat(209)}…`
        });
        expect(`connect <url removed> refused ${'x'.repeat(209)}…`).toHaveLength(240);
    });
});
