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
    const replaced = resolveReplacedLayout(input);
    const admittedReplaced = replaced === null ? null : toRtcRoomLayoutEdges(replaced, authorizedPeerIdSet);
    const elapsedMs = input.nowMs - (input.history.transition?.replacedAtEpochMs ?? input.nowMs);
    const admits = elapsedMs >= 0 && elapsedMs < input.history.replacedLayoutOverlapMs;
    const forwards = elapsedMs >= 0 &&
        elapsedMs < computeReplacedLayoutForwardingMs(input.history.replacedLayoutOverlapMs);
    const previous = forwards ? admittedReplaced : null;
    const admittedEdgePeerIds = [
        ...new Set([...input.accepted.nextHopSessionIds, ...(admits ? admittedReplaced?.neighbourPeerIds ?? [] : [])])
    ];
    return { accepted, previous, admittedEdgePeerIds };
}

/**
 * A sender or relay forwards over a replaced layout for the first half of the overlap its receiver admits, so the
 * second half absorbs the difference between the instants at which two browsers applied the same promotion.
 */
function computeReplacedLayoutForwardingMs(replacedLayoutOverlapMs: number): number {
    return Math.floor(replacedLayoutOverlapMs / 2);
}

function resolveReplacedLayout(input: ResolveRtcRoomRoutingEdgesInput): OverlayInfo | null {
    const transition = input.history.transition;
    if (
        transition === null ||
        !isRoomLayoutOverlay(input.accepted, input.roomRef) ||
        !isRoomLayoutOverlay(transition.replaced, input.roomRef) ||
        !isOverlayIdentity(input.accepted, transition.replacedBy)
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
