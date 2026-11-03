import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { StateScope } from '../../../api/state-types.ts';
import type { WsCapturedRecipientEligibilityFilter } from '../ws-queue-box-server-contracts.ts';
import { resolveWsQueueBoxServerRecipientScope } from './resolve-ws-queue-box-server-recipient-scope.ts';

export interface ReadWsQueueBoxServerEligibleAudienceInput {
    readonly message: ALMessage;
    readonly admittedAudience: readonly string[];
    readonly admittedConnectionGenerationIds: Readonly<Record<string, string>> | undefined;
    /** The scope the row's producer proved; a row whose targets name a group is scoped by that group. */
    readonly provenScope: StateScope | undefined;
    readonly filterEligibleCapturedSessionIds: WsCapturedRecipientEligibilityFilter;
}

/** The admitted sessions the re-check still finds eligible, in admitted order: a re-check only ever narrows. */
export async function readWsQueueBoxServerEligibleAudience(
    input: ReadWsQueueBoxServerEligibleAudienceInput
): Promise<readonly string[]> {
    const eligible = new Set(
        await input.filterEligibleCapturedSessionIds({
            message: input.message,
            candidateSessionIds: input.admittedAudience,
            recipientScope: resolveWsQueueBoxServerRecipientScope(input.message, input.provenScope),
            capturedConnectionGenerationIds: input.admittedConnectionGenerationIds ?? null
        })
    );
    return input.admittedAudience.filter((sessionId) => eligible.has(sessionId));
}
