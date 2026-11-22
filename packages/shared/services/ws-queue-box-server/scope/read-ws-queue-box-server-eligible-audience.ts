import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { AL_OUTBOUND_WORK_LEASE_MS } from '../../../alm/outbound/al-outbound-work-entry.ts';
import type { StateScope } from '../../../api/state-types.ts';
import type { Timers } from '../../../resilience/timers.ts';
import { runWithClaimableDeadline } from '../../../resilience/timing/run-with-claimable-deadline.ts';
import type { WsCapturedRecipientEligibilityFilter } from '../ws-queue-box-server-contracts.ts';
import { resolveWsQueueBoxServerRecipientScope } from './resolve-ws-queue-box-server-recipient-scope.ts';

/** The read settles inside the lease that claimed the row, leaving half of it for the commit and the send. */
export const WS_CAPTURED_AUDIENCE_READ_DEADLINE_MS = AL_OUTBOUND_WORK_LEASE_MS / 2;

/** The re-check's read did not answer within its deadline; the attempt sends nothing and its row retries. */
export class WsCapturedAudienceReadDeadlineError extends Error {
    readonly deadlineMs: number;

    constructor(deadlineMs: number) {
        super(`The captured-audience re-check did not answer within ${deadlineMs} ms`);
        this.name = 'WsCapturedAudienceReadDeadlineError';
        this.deadlineMs = deadlineMs;
    }
}

export interface ReadWsQueueBoxServerEligibleAudienceInput {
    readonly message: ALMessage;
    readonly admittedAudience: readonly string[];
    readonly admittedConnectionGenerationIds: Readonly<Record<string, string>> | undefined;
    /** The scope the row's producer proved; a row whose targets name a group is scoped by that group. */
    readonly provenScope: StateScope | undefined;
    readonly filterEligibleCapturedSessionIds: WsCapturedRecipientEligibilityFilter;
    readonly timers: Timers;
}

/**
 * The admitted sessions the re-check still finds eligible, in admitted order: a re-check only ever narrows. A read
 * that does not answer within the deadline rejects, and its late answer is ignored.
 */
export async function readWsQueueBoxServerEligibleAudience(
    input: ReadWsQueueBoxServerEligibleAudienceInput
): Promise<readonly string[]> {
    const outcome = await runWithClaimableDeadline(
        input.timers,
        WS_CAPTURED_AUDIENCE_READ_DEADLINE_MS,
        async () =>
            await input.filterEligibleCapturedSessionIds({
                message: input.message,
                candidateSessionIds: input.admittedAudience,
                recipientScope: resolveWsQueueBoxServerRecipientScope(input.message, input.provenScope),
                capturedConnectionGenerationIds: input.admittedConnectionGenerationIds ?? null
            })
    );
    if (outcome.kind === 'expired') {
        throw new WsCapturedAudienceReadDeadlineError(outcome.deadlineMs);
    }
    const eligible = new Set(outcome.value);
    return input.admittedAudience.filter((sessionId) => eligible.has(sessionId));
}
