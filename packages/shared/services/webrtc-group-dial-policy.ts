import type { OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupLifecycleState } from '../api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveDialLayoutRoles } from '../api/group-lifecycle/resolve-dial-layout-roles.ts';

export interface SelectGroupDialPeerIdsInput {
    readonly lifecycleState: GroupLifecycleState;
    readonly localSessionId: PeerId;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

/**
 * The browser's complete missing-peer selection policy. Only authoritative
 * server layouts can create RTC peers; a local bootstrap overlay remains RTT
 * evidence and never substitutes for a missing lifecycle-selected layout.
 */
export function selectGroupDialPeerIds(
    input: SelectGroupDialPeerIdsInput
): readonly PeerId[] {
    const plannedPeerIds = serverLayoutPeerIds(
        input.planned,
        input.localSessionId
    );
    const acceptedPeerIds = serverLayoutPeerIds(
        input.accepted,
        input.localSessionId
    );

    switch (resolveDialLayoutRoles(input.lifecycleState)) {
        case 'none':
            return [];
        case 'planned':
            return plannedPeerIds;
        case 'accepted':
            return acceptedPeerIds;
        case 'accepted-and-planned':
            return [...new Set([...acceptedPeerIds, ...plannedPeerIds])];
    }
}

function serverLayoutPeerIds(
    overlay: OverlayInfo | undefined,
    localSessionId: PeerId
): readonly PeerId[] {
    if (overlay?.provenance !== 'server' || overlay.state !== 'active') {
        return [];
    }

    return overlay.nextHopSessionIds.filter(
        (peerId) => peerId !== localSessionId
    );
}
