import { RetryableConflictError, TryWithExhaustedError, TryWithPolicy } from '../../../resilience/try-with-policy.ts';

export interface ALInboundLostWriteRetry<TAnswer> {
    /** One whole attempt: its reads, its decision, its validation and its conditional write. */
    readonly attempt: () => Promise<TAnswer>;
    /** Whether the answer is the store's `conflict` to this attempt's own write; any other answer ends the attempts. */
    readonly isLostWrite: (answer: TAnswer) => boolean;
}

const AL_INBOUND_LOST_WRITE_ATTEMPTS = 3;

class ALInboundLostWrite<TAnswer> extends RetryableConflictError {
    readonly answer: TAnswer;

    constructor(answer: TAnswer) {
        super('Inbound write lost to a concurrent write');
        this.answer = answer;
    }
}

const AL_INBOUND_LOST_WRITE_RETRY = TryWithPolicy.defaults()
    .label('inbound lost write')
    .maxAttempts(AL_INBOUND_LOST_WRITE_ATTEMPTS)
    .retryIf((error) => error instanceof ALInboundLostWrite)
    .waitBeforeRetry(() => Promise.resolve());

/**
 * Runs `attempt` again, at once, while it answers a lost write, three attempts in all, and answers the last
 * attempt's own answer. A lost write means the winner committed, so the next attempt's read sees it; bounded, so
 * contention never holds the caller. The conflict the retry primitive counts attempts by never leaves this
 * function, and an error that is no conflict leaves it as it was thrown, from any attempt.
 */
export async function retryALInboundLostWrite<TAnswer>(retry: ALInboundLostWriteRetry<TAnswer>): Promise<TAnswer> {
    try {
        return await AL_INBOUND_LOST_WRITE_RETRY.run(async () => {
            const answer = await retry.attempt();
            if (retry.isLostWrite(answer)) {
                throw new ALInboundLostWrite(answer);
            }
            return answer;
        });
    }
    catch (error) {
        const cause = error instanceof TryWithExhaustedError ? error.cause : error;
        if (cause instanceof ALInboundLostWrite) {
            return cause.answer;
        }
        throw cause;
    }
}
