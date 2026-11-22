import {
    resolveALUpstreamPeerId,
    toALOverlayAdjacency,
    type ALOverlayAdjacency
} from '../al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { OverlayInfo } from '../api/api-config.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupSnapshot } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { isAcceptedRoomLayoutOverlay } from '../repository/is-accepted-room-layout-overlay.ts';
import { toAcceptedOverlayContext } from './compute-rtc-outbound-carrier-availability.ts';
import { readRtcGroupSnapshotByRef, type RtcOutboundObservation } from './read-rtc-outbound-observation.ts';
import { resolveRtcRoomRoutingEdges } from './room-authority/resolve-rtc-room-routing-edges.ts';

/** What a relay reads of every room it holds to route a NACK about a message it holds nothing of. */
export interface RtcRelayRoutes {
    readonly rooms: ReadableKeyedValues<string, GroupSnapshot>;
    readonly acceptedOverlays: ReadableKeyedValues<string, OverlayInfo>;
    readonly selfPeerId: string;
    readonly connectedPeerIds: readonly string[];
}

/** The accepted layout's adjacency seen from `selfPeerId`; absent when no layout is accepted or it carries none. */
export function toRtcAcceptedOverlayAdjacency(
    observation: RtcOutboundObservation,
    selfPeerId: string
): ALOverlayAdjacency | undefined {
    return toALOverlayAdjacency(selfPeerId, toAcceptedOverlayContext(observation)?.overlay.nextHopsBySessionId);
}

/** The one connected neighbour toward `originPeerId` in the accepted layout; none when that layout places none. */
export function resolveRtcUpstreamPeerId(
    observation: RtcOutboundObservation,
    selfPeerId: string,
    originPeerId: string
): string | undefined {
    return resolveALUpstreamPeerId(
        toRtcAcceptedOverlayAdjacency(observation, selfPeerId),
        originPeerId,
        observation.connectedPeerIds
    );
}

/**
 * Whether `peerId` is a connected neighbour this session still routes over: in the accepted layout, or in the layout it
 * replaced while a sender or relay still forwards over that one.
 */
export function isRtcRoutedPeerReady(observation: RtcOutboundObservation, peerId: string): boolean {
    const context = toAcceptedOverlayContext(observation);
    if (context === undefined || !observation.connectedPeerIds.includes(peerId)) {
        return false;
    }
    const edges = resolveRtcRoomRoutingEdges({
        roomRef: context.room.group,
        accepted: context.overlay,
        layoutChanges: context.layoutChanges,
        authorizedPeerIds: readGroupMemberSessionIds(context.room),
        nowMs: context.nowMs
    });
    return edges.acceptedNeighborPeerIds.includes(peerId) || edges.previous?.neighborPeerIds.includes(peerId) === true;
}

/**
 * The parent a relay forwards a child's NACK to when it holds nothing of the message: its one connected upstream peer
 * toward `originPeerId` over the accepted layouts in which `childPeerId` is its neighbour below it; none when no layout,
 * or more than one parent, answers.
 */
export function resolveRtcRelayParentPeerId(
    routes: RtcRelayRoutes,
    originPeerId: string,
    childPeerId: string
): string | undefined {
    const parentPeerIds = new Set(
        routes.acceptedOverlays.readAllValues().flatMap((overlay) => {
            const room = readRtcGroupSnapshotByRef(routes.rooms, overlay.groupRef);
            const adjacency = room !== undefined && isAcceptedRoomLayoutOverlay(overlay, room.group)
                ? toALOverlayAdjacency(routes.selfPeerId, overlay.nextHopsBySessionId)
                : undefined;
            const parentPeerId = resolveALUpstreamPeerId(adjacency, originPeerId, routes.connectedPeerIds);
            const isChild = parentPeerId !== childPeerId &&
                adjacency?.nextHopsBySessionId[routes.selfPeerId]?.includes(childPeerId) === true;
            return parentPeerId !== undefined && isChild ? [parentPeerId] : [];
        })
    );
    return parentPeerIds.size === 1 ? [...parentPeerIds][0] : undefined;
}
