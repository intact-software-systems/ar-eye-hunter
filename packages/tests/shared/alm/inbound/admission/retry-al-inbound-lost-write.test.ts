// A lost answer leaves no stored trace here, so each case's record of the attempts is the list its own attempt
// function appends to.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryALInboundLostWrite } from '@shared/alm/inbound/admission/retry-al-inbound-lost-write.ts';
import { RetryableConflictError } from '@shared/resilience/try-with-policy.ts';

type Answer = 'completed' | 'conflict';

/** An attempt function that answers `answers` in turn and appends each answer it gives to `made`. */
function createAttempts(answers: readonly Answer[], made: Answer[]): () => Promise<Answer> {
    return async () => {
        const answer = answers[made.length];
        if (answer === undefined) {
            throw new Error(`unexpected attempt ${made.length + 1}: the case scripted ${answers.length} answers`);
        }
        made.push(answer);
        return answer;
    };
}

function isLostWrite(answer: Answer): boolean {
    return answer === 'conflict';
}

describe('an inbound write that is lost is attempted again at once', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    // A committed answer is final: another attempt would write a second time.
    it('answers the first attempt when it is no lost write, and makes no other', async () => {
        const made: Answer[] = [];

        expect(await retryALInboundLostWrite({ attempt: createAttempts(['completed'], made), isLostWrite }))
            .toBe('completed');

        expect(made).toEqual(['completed']);
    });

    // The last of the bounded attempts still runs and its answer is the one returned.
    it('answers the third attempt after two lost writes', async () => {
        const made: Answer[] = [];
        const attempt = createAttempts(['conflict', 'conflict', 'completed'], made);

        expect(await retryALInboundLostWrite({ attempt, isLostWrite })).toBe('completed');

        expect(made).toEqual(['conflict', 'conflict', 'completed']);
    });

    // The bound holds: contention never keeps the caller, and the lost answer, not a thrown conflict, comes back.
    it('answers the third lost answer when every attempt lost, and makes no fourth', async () => {
        const made: Answer[] = [];
        const attempt = createAttempts(['conflict', 'conflict', 'conflict', 'completed'], made);

        expect(await retryALInboundLostWrite({ attempt, isLostWrite })).toBe('conflict');

        expect(made).toEqual(['conflict', 'conflict', 'conflict']);
    });

    // Only a lost write is attempted again: any other failure fails the caller unchanged.
    it('lets an error that is no conflict out as the object it was thrown as, from the first attempt', async () => {
        const failure = new Error('admission storage unavailable');
        const made: string[] = [];
        const attempt = async (): Promise<Answer> => {
            made.push('failed');
            throw failure;
        };

        await expect(retryALInboundLostWrite({ attempt, isLostWrite })).rejects.toBe(failure);

        expect(made).toEqual(['failed']);
    });

    // The retry primitive wraps an error thrown by its last attempt; the caller must still see the error itself.
    it('lets an error that is no conflict out as the object it was thrown as, from the third attempt', async () => {
        const failure = new Error('admission storage unavailable');
        const made: Answer[] = [];
        const lostTwice = createAttempts(['conflict', 'conflict'], made);
        const attempt = async (): Promise<Answer> => {
            if (made.length === 2) {
                throw failure;
            }
            return await lostTwice();
        };

        await expect(retryALInboundLostWrite({ attempt, isLostWrite })).rejects.toBe(failure);

        expect(made).toEqual(['conflict', 'conflict']);
    });

    // Only the function's own lost-write signal is retried: a conflict the attempt throws is not a lost answer.
    it('lets a retryable conflict the attempt itself throws out, without another attempt', async () => {
        const conflict = new RetryableConflictError('thrown by the attempt');
        const made: string[] = [];
        const attempt = async (): Promise<Answer> => {
            made.push('thrown');
            throw conflict;
        };

        await expect(retryALInboundLostWrite({ attempt, isLostWrite })).rejects.toBe(conflict);

        expect(made).toEqual(['thrown']);
    });

    // A lost write means the winner committed, so no wait is owed; a timer here would hold the caller.
    it('makes its attempts with no timer between them', async () => {
        vi.useFakeTimers();
        const made: Answer[] = [];
        const attempt = createAttempts(['conflict', 'conflict', 'completed'], made);

        expect(await retryALInboundLostWrite({ attempt, isLostWrite })).toBe('completed');

        expect(made).toEqual(['conflict', 'conflict', 'completed']);
    });
});
