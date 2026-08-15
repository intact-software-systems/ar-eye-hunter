import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RtcRttAcceptanceReason } from '../rtc-topology/policy/rtc-rtt-measurement-policy.ts';
import type { RtcRttMutationComputed } from './rtc-topology-mutations.ts';

export type RtcRttAppInboxResult = Readonly<{
    requestId: string;
    accepted: boolean;
    reason: RtcRttAcceptanceReason;
    affectedGroups: readonly GroupSnapshot[];
    updated: boolean;
}>;

export function toRtcRttAppInboxResult(
    computed: RtcRttMutationComputed,
    requestId: string,
): RtcRttAppInboxResult {
    if (computed.outcome === 'replay') {
        return acceptedResult(requestId, [], false);
    }
    if (computed.outcome === 'rejected') {
        return computed.reason === 'stale'
            ? acceptedResult(requestId, [], false)
            : {
                requestId,
                accepted: false,
                reason: computed.reason,
                affectedGroups: computed.affectedGroups,
                updated: false,
            };
    }
    return acceptedResult(
        requestId,
        computed.affectedGroups,
        true,
        computed.reason,
    );
}

function acceptedResult(
    requestId: string,
    affectedGroups: readonly GroupSnapshot[],
    updated: boolean,
    reason: RtcRttAcceptanceReason = 'accepted',
): RtcRttAppInboxResult {
    return { requestId, accepted: true, reason, affectedGroups, updated };
}
