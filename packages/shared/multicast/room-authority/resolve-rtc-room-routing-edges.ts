import type { ALOverlayLayout } from '../../al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { OverlayInfo } from '../../api/api-config.ts';
import type { GroupRef } from '../../api/group-types.ts';
import { isRoomLayoutOverlay } from '../../repository/is-accepted-room-layout-overlay.ts';
import {
    isLayoutTransitionInsideWindow,
    isLayoutTransitionReplacedBy,
    type OverlayLayoutTransition
} from '../../repository/overlay-layout-transition.ts';
import { toOverlayLayoutIdentity } from '../../repository/to-overlay-layout-identity.ts';

export interface RtcRoomLayoutChanges {
    /** Every layout this session replaced for the room that is still recorded, newest first; empty when none. */
    readonly transitions: readonly OverlayLayoutTransition[];
    readonly replacedLayoutOverlapMs: number;
    /** The layout this session holds planned for the room, which the server has not promoted here yet; else `null`. */
    readonly planned: OverlayInfo | null;
}

export interface ResolveRtcRoomRoutingEdgesInput {
    readonly roomRef: GroupRef;
    readonly accepted: OverlayInfo;
    readonly layoutChanges: RtcRoomLayoutChanges;
    readonly authorizedPeerIds: readonly string[];
    readonly nowMs: number;
}

export interface RtcRoomRoutingEdges {
    readonly acceptedNeighborPeerIds: readonly string[];
    /**
     * The most recent replaced layout's edges a sender or relay may still forward over: only for the first half of the
     * overlap, rounded down to a whole millisecond; else `null`.
     */
    readonly previous: ALOverlayLayout | null;
    /**
     * The accepted layout's next hops, and the authorized neighbours of every replaced layout in the chain that ends at
     * the accepted layout, each for its own whole overlap.
     */
    readonly admittedEdgePeerIds: readonly string[];
    /**
     * The planned layout's authorized neighbours that are not admitted: a receiver awaits its own promotion of that
     * layout before it judges their copies. Nothing is delivered, forwarded or sent on the strength of this set.
     */
    readonly awaitedEdgePeerIds: readonly string[];
}

interface RtcReplacedLayoutEdges {
    readonly previous: ALOverlayLayout | null;
    readonly admittedPeerIds: readonly string[];
}

const NO_REPLACED_LAYOUT_EDGES: RtcReplacedLayoutEdges = { previous: null, admittedPeerIds: [] };

export function resolveRtcRoomRoutingEdges(input: ResolveRtcRoomRoutingEdgesInput): RtcRoomRoutingEdges {
    const authorizedPeerIdSet = new Set(input.authorizedPeerIds);
    const acceptedNeighborPeerIds = isRoomLayoutOverlay(input.accepted, input.roomRef)
        ? toALOverlayLayout(input.accepted, authorizedPeerIdSet).neighborPeerIds
        : [];
    const replaced = resolveReplacedLayoutEdges(input, authorizedPeerIdSet);
    const admittedEdgePeerIds = [...new Set([...input.accepted.nextHopSessionIds, ...replaced.admittedPeerIds])];
    const awaitedEdgePeerIds = resolvePlannedLayoutNeighbors(input, authorizedPeerIdSet)
        .filter((peerId) => !admittedEdgePeerIds.includes(peerId));
    return { acceptedNeighborPeerIds, previous: replaced.previous, admittedEdgePeerIds, awaitedEdgePeerIds };
}

function resolvePlannedLayoutNeighbors(
    input: ResolveRtcRoomRoutingEdgesInput,
    authorizedPeerIdSet: ReadonlySet<string>
): readonly string[] {
    const planned = input.layoutChanges.planned ?? undefined;
    return isRoomLayoutOverlay(planned, input.roomRef)
        ? toALOverlayLayout(planned, authorizedPeerIdSet).neighborPeerIds
        : [];
}

/**
 * A receiver admits the authorized neighbours of every replaced layout in the chain that ends at the accepted layout
 * whose own overlap is open; a sender or relay forwards over the most recent one only, for the first half of its
 * overlap.
 */
function resolveReplacedLayoutEdges(
    input: ResolveRtcRoomRoutingEdgesInput,
    authorizedPeerIdSet: ReadonlySet<string>
): RtcReplacedLayoutEdges {
    const chain = resolveReplacingTransitionChain(input);
    const newest = chain[0];
    if (newest === undefined) {
        return NO_REPLACED_LAYOUT_EDGES;
    }
    const overlapMs = input.layoutChanges.replacedLayoutOverlapMs;
    const forwards = isLayoutTransitionInsideWindow(newest, input.nowMs, computeReplacedLayoutForwardingMs(overlapMs));
    const admittedPeerIds = chain
        .filter((transition) => isLayoutTransitionInsideWindow(transition, input.nowMs, overlapMs))
        .flatMap((transition) => toALOverlayLayout(transition.replaced, authorizedPeerIdSet).neighborPeerIds);
    return {
        previous: forwards ? toALOverlayLayout(newest.replaced, authorizedPeerIdSet) : null,
        admittedPeerIds
    };
}

/**
 * A sender or relay forwards over a replaced layout for the first half of the overlap its receiver admits, so the
 * second half absorbs the difference between the instants at which two browsers applied the same promotion.
 */
function computeReplacedLayoutForwardingMs(replacedLayoutOverlapMs: number): number {
    return Math.floor(replacedLayoutOverlapMs / 2);
}

/**
 * The recorded transitions that lead, unbroken, to the accepted layout: the newest one's replacer is the accepted
 * layout, and each older one's replacer is the layout the next newer one replaced. A break, or a replaced layout that
 * is not a live server layout of this room, ends the chain there.
 */
function resolveReplacingTransitionChain(input: ResolveRtcRoomRoutingEdgesInput): readonly OverlayLayoutTransition[] {
    if (!isRoomLayoutOverlay(input.accepted, input.roomRef)) {
        return [];
    }
    const chain: OverlayLayoutTransition[] = [];
    let replacer: OverlayInfo = input.accepted;
    for (const transition of input.layoutChanges.transitions) {
        if (!isLayoutTransitionReplacedBy(transition, input.roomRef, toOverlayLayoutIdentity(replacer))) {
            break;
        }
        chain.push(transition);
        replacer = transition.replaced;
    }
    return chain;
}

function toALOverlayLayout(layout: OverlayInfo, authorizedPeerIdSet: ReadonlySet<string>): ALOverlayLayout {
    return {
        neighborPeerIds: layout.nextHopSessionIds.filter((peerId) => authorizedPeerIdSet.has(peerId)),
        nextHopsBySessionId: layout.nextHopsBySessionId
    };
}
