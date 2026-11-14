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
    /**
     * The replaced layout's edges a sender or relay may still forward over: only for the first half of the overlap,
     * rounded down to a whole millisecond; else `null`.
     */
    readonly previous: RtcRoomLayoutEdges | null;
    /** The accepted layout's next hops, and the replaced layout's authorized neighbours for the whole overlap. */
    readonly admittedEdgePeerIds: readonly string[];
}

interface RtcReplacedLayoutEdges {
    readonly previous: RtcRoomLayoutEdges | null;
    readonly admittedPeerIds: readonly string[];
}

const NO_REPLACED_LAYOUT_EDGES: RtcReplacedLayoutEdges = { previous: null, admittedPeerIds: [] };

export function resolveRtcRoomRoutingEdges(input: ResolveRtcRoomRoutingEdgesInput): RtcRoomRoutingEdges {
    const authorizedPeerIdSet = new Set(input.authorizedPeerIds);
    const acceptedNeighbourPeerIdSet = isRoomLayoutOverlay(input.accepted, input.roomRef)
        ? authorizedPeerIdSet
        : new Set<string>();
    const accepted = toRtcRoomLayoutEdges(input.accepted, acceptedNeighbourPeerIdSet);
    const replaced = resolveReplacedLayoutEdges(input, authorizedPeerIdSet);
    const admittedEdgePeerIds = [...new Set([...input.accepted.nextHopSessionIds, ...replaced.admittedPeerIds])];
    return { accepted, previous: replaced.previous, admittedEdgePeerIds };
}

/** With no transition of this room for the accepted layout, there is no replaced layout to admit or forward over. */
function resolveReplacedLayoutEdges(
    input: ResolveRtcRoomRoutingEdgesInput,
    authorizedPeerIdSet: ReadonlySet<string>
): RtcReplacedLayoutEdges {
    const transition = resolveReplacingTransition(input);
    if (transition === null) {
        return NO_REPLACED_LAYOUT_EDGES;
    }
    const edges = toRtcRoomLayoutEdges(transition.replaced, authorizedPeerIdSet);
    const elapsedMs = input.nowMs - transition.replacedAtEpochMs;
    const overlapMs = input.history.replacedLayoutOverlapMs;
    const admits = elapsedMs >= 0 && elapsedMs < overlapMs;
    const forwards = elapsedMs >= 0 && elapsedMs < computeReplacedLayoutForwardingMs(overlapMs);
    return { previous: forwards ? edges : null, admittedPeerIds: admits ? edges.neighbourPeerIds : [] };
}

/**
 * A sender or relay forwards over a replaced layout for the first half of the overlap its receiver admits, so the
 * second half absorbs the difference between the instants at which two browsers applied the same promotion.
 */
function computeReplacedLayoutForwardingMs(replacedLayoutOverlapMs: number): number {
    return Math.floor(replacedLayoutOverlapMs / 2);
}

function resolveReplacingTransition(input: ResolveRtcRoomRoutingEdgesInput): OverlayLayoutTransition | null {
    const transition = input.history.transition;
    if (
        transition === null ||
        !isRoomLayoutOverlay(input.accepted, input.roomRef) ||
        !isRoomLayoutOverlay(transition.replaced, input.roomRef) ||
        !isOverlayIdentity(input.accepted, transition.replacedBy)
    ) {
        return null;
    }
    return transition;
}

function toRtcRoomLayoutEdges(layout: OverlayInfo, authorizedPeerIdSet: ReadonlySet<string>): RtcRoomLayoutEdges {
    return {
        neighbourPeerIds: layout.nextHopSessionIds.filter((peerId) => authorizedPeerIdSet.has(peerId)),
        nextHopsBySessionId: layout.nextHopsBySessionId
    };
}
