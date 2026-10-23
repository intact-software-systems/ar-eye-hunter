import type { OverlayInfo } from '@shared/api/api-config.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import type { GroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupTransportState } from '@shared/api/group-lifecycle/group-lifecycle-policy.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isAcceptedRoomLayoutOverlay } from '@shared/repository/is-accepted-room-layout-overlay.ts';
import { toOverlayLayoutIdentity } from '@shared/repository/overlays-repository.ts';

export interface BrowserRoomTransportTarget {
    readonly transportState?: GroupTransportState;
    readonly acceptedLayoutIdentity?: GroupLayoutIdentity;
    readonly acceptedLayoutCoversCurrentPresence: boolean;
    readonly peerIds: readonly string[];
}

export interface ResolveBrowserRoomTransportTargetInput {
    readonly sessionId: string | undefined;
    readonly snapshot: GroupSnapshot | undefined;
    readonly acceptedOverlay: OverlayInfo | undefined;
}

export function resolveBrowserRoomTransportTarget(
    input: ResolveBrowserRoomTransportTargetInput
): BrowserRoomTransportTarget {
    if (
        !input.sessionId ||
        !input.snapshot ||
        !isGroupActive(input.snapshot) ||
        !isSessionInGroup(input.snapshot, input.sessionId)
    ) {
        return { acceptedLayoutCoversCurrentPresence: false, peerIds: [] };
    }

    const acceptedOverlay = input.acceptedOverlay;
    const hasAcceptedLayout = isAcceptedRoomLayoutOverlay(acceptedOverlay, input.snapshot.group);
    const acceptedLayoutIdentity = hasAcceptedLayout
        ? toOverlayLayoutIdentity(acceptedOverlay)
        : undefined;
    const activeSessionIds = new Set(input.snapshot.activeSessions.map((session) => session.sessionId));
    return {
        transportState: input.snapshot.group.transportState,
        ...(acceptedLayoutIdentity === undefined ? {} : { acceptedLayoutIdentity }),
        acceptedLayoutCoversCurrentPresence: acceptedLayoutIdentity?.presenceRevision ===
            input.snapshot.causalRevision.presenceRevision,
        peerIds: hasAcceptedLayout
            ? [
                ...new Set(
                    acceptedOverlay.nextHopSessionIds.filter(
                        (peerId) => peerId !== input.sessionId && activeSessionIds.has(peerId)
                    )
                )
            ]
            : []
    };
}
