export interface ALInboundLostWriteRetry<TAnswer> {
    /** One whole attempt: its reads, its decision, its validation and its conditional write. */
    readonly attempt: () => Promise<TAnswer>;
    /** Whether the answer is the store's `conflict` to this attempt's own write; any other answer ends the attempts. */
    readonly isLostWrite: (answer: TAnswer) => boolean;
}

const AL_INBOUND_LOST_WRITE_ATTEMPTS = 3;

/**
 * Runs `attempt` again, at once, while it answers a lost write, three attempts in all, and answers the last
 * attempt's own answer. A lost write means the winner committed, so the next attempt's read sees it; bounded, so
 * contention never holds the caller. Nothing passes from one attempt to the next: each runs its owner's every step
 * again (its reads, its decision, its validation, any proof check and signing, and its write), so a diagnostic an
 * attempt records before its write, such as a failed receipt signature, is recorded once per attempt, and a lost
 * attempt wrote nothing, since its write commits whole or not at all. An error an attempt throws leaves as it was
 * thrown, and no further attempt is made.
 */
export async function retryALInboundLostWrite<TAnswer>(retry: ALInboundLostWriteRetry<TAnswer>): Promise<TAnswer> {
    let answer = await retry.attempt();
    for (let made = 1; made < AL_INBOUND_LOST_WRITE_ATTEMPTS && retry.isLostWrite(answer); made += 1) {
        answer = await retry.attempt();
    }
    return answer;
}
