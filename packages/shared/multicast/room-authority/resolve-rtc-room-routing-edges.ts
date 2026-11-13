import type { OverlayInfo } from '../../api/api-config.ts';
import type { GroupRef } from '../../api/group-types.ts';
import { isRoomLayoutOverlay } from '../../repository/is-accepted-room-layout-overlay.ts';
import type { OverlayLayoutTransition } from '../../repository/overlay-layout-transition.ts';
import { isOverlayIdentity } from '../../repository/to-overlay-layout-identity.ts';

export interface RtcRoomLayoutHistory {
    readonly transition: OverlayLayoutTransition | null;
    readonly replacedLayoutOverlapMs: number;
}

export interface ResolveRtcRoomRoutingEdgesInput {
    readonly roomRef: GroupRef;
    readonly accepted: OverlayInfo;
    readonly history: RtcRoomLayoutHistory;
    readonly authorizedPeerIds: readonly string[];
    readonly nowMs: number;
}

export interface RtcRoomLayoutEdges {
    readonly neighbourPeerIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>> | undefined;
}

export interface RtcRoomRoutingEdges {
    readonly accepted: RtcRoomLayoutEdges;
    readonly previous: RtcRoomLayoutEdges | null;
    readonly admittedEdgePeerIds: readonly string[];
}

export function resolveRtcRoomRoutingEdges(input: ResolveRtcRoomRoutingEdgesInput): RtcRoomRoutingEdges {
    const authorizedPeerIdSet = new Set(input.authorizedPeerIds);
    const acceptedNeighbourPeerIdSet = isRoomLayoutOverlay(input.accepted, input.roomRef)
        ? authorizedPeerIdSet
        : new Set<string>();
    const accepted = toRtcRoomLayoutEdges(input.accepted, acceptedNeighbourPeerIdSet);
    const replaced = resolveReplacedLayoutInForce(input);
    const previous = replaced === null ? null : toRtcRoomLayoutEdges(replaced, authorizedPeerIdSet);
    const admittedEdgePeerIds = [
        ...new Set([...input.accepted.nextHopSessionIds, ...(previous?.neighbourPeerIds ?? [])])
    ];
    return { accepted, previous, admittedEdgePeerIds };
}

function resolveReplacedLayoutInForce(input: ResolveRtcRoomRoutingEdgesInput): OverlayInfo | null {
    const transition = input.history.transition;
    if (
        transition === null ||
        !isRoomLayoutOverlay(input.accepted, input.roomRef) ||
        !isRoomLayoutOverlay(transition.replaced, input.roomRef) ||
        !isOverlayIdentity(input.accepted, transition.replacedBy) ||
        input.nowMs < transition.replacedAtEpochMs ||
        input.nowMs >= transition.replacedAtEpochMs + input.history.replacedLayoutOverlapMs
    ) {
        return null;
    }
    return transition.replaced;
}

function toRtcRoomLayoutEdges(layout: OverlayInfo, authorizedPeerIdSet: ReadonlySet<string>): RtcRoomLayoutEdges {
    return {
        neighbourPeerIds: layout.nextHopSessionIds.filter((peerId) => authorizedPeerIdSet.has(peerId)),
        nextHopsBySessionId: layout.nextHopsBySessionId
    };
}
