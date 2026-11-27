import { describe, expect, it } from 'vitest';

import type { ALMessageRejection } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import { readOrderedSendCellAnswer } from '../../../../../../apps/api-v1/scripts/perf/alm-ordered-send/answer/read-ordered-send-cell-answer.ts';

type EntryAnswer = Either<ALMessageRejection, ALInboundMessageRuntime.Acceptance>;

/** A clock that reads 100 ms, then 250.5 ms, then 400 ms: one reading for each time it is asked. */
function createClock(): () => number {
    const readings = [100, 250.5, 400];
    return () => readings.shift() ?? Number.NaN;
}

describe('readOrderedSendCellAnswer', () => {
    it('reads what the entry answered, at the instant the answer came and not the instant of the offer', async () => {
        const nowMs = createClock();
        let offeredAtMs: number | undefined;

        const answer = await readOrderedSendCellAnswer(async (): Promise<EntryAnswer> => {
            offeredAtMs = nowMs();
            return Either.ofRight({ kind: 'duplicate' });
        }, nowMs);

        expect(offeredAtMs).toBe(100);
        expect(answer).toEqual({ acceptance: 'duplicate', answeredAtMs: 250.5 });
    });

    it('answers an entry whose answer rejects as an offer that threw, and rejects nothing itself', async () => {
        const corruption = new Error('Buffered inbound ordering slot lost its canonical message');
        corruption.name = 'ALAdmissionCorruptionError';

        const answer = await readOrderedSendCellAnswer(() => Promise.reject<EntryAnswer>(corruption), () => 812.25);

        expect(answer).toEqual({
            acceptance: 'threw',
            answeredAtMs: 812.25,
            errorName: 'ALAdmissionCorruptionError',
            errorMessage: 'Buffered inbound ordering slot lost its canonical message'
        });
    });

    it('answers an entry that throws before it returns a promise, or throws what is no error, the same way', async () => {
        const threwAtOnce = await readOrderedSendCellAnswer((): Promise<EntryAnswer> => {
            throw new TypeError('frame is not an object');
        }, () => 5);
        const threwAText = await readOrderedSendCellAnswer(() => Promise.reject<EntryAnswer>('pool closed'), () => 6);

        expect(threwAtOnce).toEqual({
            acceptance: 'threw',
            answeredAtMs: 5,
            errorName: 'TypeError',
            errorMessage: 'frame is not an object'
        });
        expect(threwAText).toEqual({ acceptance: 'threw', answeredAtMs: 6, errorName: 'Error', errorMessage: 'pool closed' });
    });
});
