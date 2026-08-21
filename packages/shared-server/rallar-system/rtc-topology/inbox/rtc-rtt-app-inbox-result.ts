import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcRttMutationComputed } from '../mutation/rtc-rtt-mutation-contracts.ts';
import type { RtcRttAcceptanceReason } from '../policy/rtc-rtt-measurement-policy.ts';

export type RtcRttAppInboxResult = Readonly<{
    requestId: string;
    accepted: boolean;
    reason: RtcRttAcceptanceReason;
    affectedGroups: readonly GroupSnapshot[];
    updated: boolean;
}>;

interface AcceptedResultInput {
    readonly requestId: string;
    readonly affectedGroups: readonly GroupSnapshot[];
    readonly updated: boolean;
    readonly reason?: RtcRttAcceptanceReason;
}

export function toRtcRttAppInboxResult(
    computed: RtcRttMutationComputed,
    requestId: string
): RtcRttAppInboxResult {
    if (computed.outcome === 'replay') {
        return acceptedResult({
            requestId,
            affectedGroups: [],
            updated: false
        });
    }
    if (computed.outcome === 'rejected') {
        return computed.reason === 'stale'
            ? acceptedResult({ requestId, affectedGroups: [], updated: false })
            : {
                requestId,
                accepted: false,
                reason: computed.reason,
                affectedGroups: computed.affectedGroups,
                updated: false
            };
    }
    return acceptedResult({
        requestId,
        affectedGroups: computed.affectedGroups,
        updated: true,
        reason: computed.reason
    });
}

function acceptedResult(input: AcceptedResultInput): RtcRttAppInboxResult {
    return {
        requestId: input.requestId,
        accepted: true,
        reason: input.reason ?? 'accepted',
        affectedGroups: input.affectedGroups,
        updated: input.updated
    };
}
