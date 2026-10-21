import type { GroupMutationFacts, GroupMutationIngressFacts } from './group-mutation-contracts.ts';

/** One attempt's facts: the ingress facts it reuses, its count, and the lane's clock, never before the ingress. */
export function toGroupMutationAttemptFacts(
    ingressFacts: GroupMutationIngressFacts,
    attemptCount: number,
    laneNowEpochMs: number
): GroupMutationFacts {
    return {
        ...ingressFacts,
        attemptCount,
        attemptAtEpochMs: Math.max(laneNowEpochMs, ingressFacts.nowEpochMs)
    };
}
