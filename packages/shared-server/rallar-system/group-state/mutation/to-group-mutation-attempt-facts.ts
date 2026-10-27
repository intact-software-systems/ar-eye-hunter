import type { GroupMutationFacts, GroupMutationIngressFacts } from './group-mutation-contracts.ts';

export interface GroupMutationAttemptFactsInput {
    readonly ingressFacts: GroupMutationIngressFacts;
    readonly attemptCount: number;
    readonly laneNowEpochMs: number;
    readonly traceId: string;
}

/**
 * One attempt's facts: the ingress facts it reuses, its count, the lane's clock, never before the ingress, and the
 * trace of the queued command's envelope.
 */
export function toGroupMutationAttemptFacts(input: GroupMutationAttemptFactsInput): GroupMutationFacts {
    const { ingressFacts, attemptCount, laneNowEpochMs, traceId } = input;
    return {
        ...ingressFacts,
        attemptCount,
        attemptAtEpochMs: Math.max(laneNowEpochMs, ingressFacts.nowEpochMs),
        traceId
    };
}
