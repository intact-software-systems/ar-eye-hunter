import type { ALMessage } from '../al-contracts/al-contract.ts';
import { AL_GAP_NACK_RELAY_HOP_LIMIT, computeALGapNackRelayHops } from '../al-contracts/al-message-resource-limits.ts';
import {
    resolveALChildPeerIdsTowardRecipients,
    resolveALUpstreamPeerId,
    toALOverlayAdjacency,
    type ALOverlayAdjacency
} from '../al-contracts/resolve-al-owned-child-peer-ids.ts';
import type { ALInboundMessageRuntime } from '../alm/inbound/al-inbound-message-runtime.ts';
import type { OverlayInfo } from '../api/api-config.ts';
import { readGroupMemberSessionIds } from '../api/group-client-views.ts';
import type { GroupSnapshot } from '../api/group-types.ts';
import type { ReadableKeyedValues } from '../cache/RepositoryInterfaces.ts';
import { isAcceptedRoomLayoutOverlay } from '../repository/is-accepted-room-layout-overlay.ts';
import { toAcceptedOverlayContext } from './compute-rtc-outbound-carrier-availability.ts';
import { readRtcGroupSnapshotByRef, type RtcOutboundObservation } from './read-rtc-outbound-observation.ts';
import { resolveRtcRoomRoutingEdges } from './room-authority/resolve-rtc-room-routing-edges.ts';

/** The inbound runtime's route capabilities on an RTC lane (6d). */
export type RtcInboundRoutes = Pick<
    ALInboundMessageRuntime.Dependencies,
    'readUpstreamPeerId' | 'readGapNackRelayHops' | 'isRoutedPeerReady' | 'isLayoutChildPeer' | 'readGapNackParent'
>;

/** What the route capabilities read of an RTC lane: its rooms, its accepted layouts and its connected peers. */
export interface RtcInboundRouteLane {
    readonly groupCache: ReadableKeyedValues<string, GroupSnapshot>;
    readonly overlayCache: ReadableKeyedValues<string, OverlayInfo>;
    readonly connectionService: {
        readonly input: { readonly sessionId: string; };
        readyPeerIdsForLane(): readonly string[];
    };
}

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
 * Whether `peerId` is this session's child in the layout: a neighbour on no route toward `originPeerId`, connected or
 * not. No peer is one without a layout, or in a layout that does not place the origin.
 */
export function isRtcLayoutChildPeer(
    adjacency: ALOverlayAdjacency | undefined,
    originPeerId: string,
    peerId: string
): boolean {
    if (adjacency === undefined || !Object.hasOwn(adjacency.nextHopsBySessionId, originPeerId)) {
        return false;
    }
    const neighborPeerIds = adjacency.nextHopsBySessionId[adjacency.selfPeerId] ?? [];
    return neighborPeerIds.includes(peerId) &&
        !resolveALChildPeerIdsTowardRecipients(neighborPeerIds, adjacency, [originPeerId]).includes(peerId);
}

/**
 * Whether `peerId` is a connected neighbour of the layout this session replaced, while a sender or relay still forwards
 * over that one: the old relay a reshape's overlap still routes through.
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
    return edges.previous?.neighborPeerIds.includes(peerId) === true;
}

/** The parent a relay holding nothing of a message forwards a child's gap NACK to, and the relays it grants it. */
export interface RtcRelayParent {
    readonly peerId: string;
    readonly relayHops: number;
}

/**
 * The parent a relay forwards a child's NACK to when it holds nothing of the message: its one connected upstream peer
 * toward `originPeerId` over the accepted layouts in which `childPeerId` is its child; none when no layout, or more than
 * one parent, answers. It grants the NACK the largest grant among those rooms, each read from the room's sessions once
 * its presence names the relay, the origin, the child and that parent.
 */
export function resolveRtcRelayParent(
    routes: RtcRelayRoutes,
    originPeerId: string,
    childPeerId: string
): RtcRelayParent | undefined {
    const parents = routes.acceptedOverlays.readAllValues().flatMap((overlay) => {
        const room = readRtcGroupSnapshotByRef(routes.rooms, overlay.groupRef);
        const adjacency = room !== undefined && isAcceptedRoomLayoutOverlay(overlay, room.group)
            ? toALOverlayAdjacency(routes.selfPeerId, overlay.nextHopsBySessionId)
            : undefined;
        const peerId = resolveALUpstreamPeerId(adjacency, originPeerId, routes.connectedPeerIds);
        return peerId !== undefined && isRtcLayoutChildPeer(adjacency, originPeerId, childPeerId)
            ? [{
                peerId,
                relayHops: resolveRtcGapNackRelayHops(room, [routes.selfPeerId, originPeerId, childPeerId, peerId])
            }]
            : [];
    });
    const parentPeerIds = new Set(parents.map((parent) => parent.peerId));
    return parentPeerIds.size === 1
        ? { peerId: parents[0].peerId, relayHops: Math.max(...parents.map((parent) => parent.relayHops)) }
        : undefined;
}

/**
 * The relays a session grants a gap NACK whose path is known to pass `pathPeerIds`: one fewer than the room's live
 * sessions, once the room's presence names every one of them. A leaf names itself and the origin; a relay also the
 * child the NACK came from and the peer it forwards it to. A room the lane has not read, or presence that is empty or
 * lags behind any of them, bounds nothing, so the session grants the wire ceiling rather than a grant a relay above it
 * would refuse.
 */
export function resolveRtcGapNackRelayHops(room: GroupSnapshot | undefined, pathPeerIds: readonly string[]): number {
    const sessionIds = room === undefined ? [] : readGroupMemberSessionIds(room);
    return pathPeerIds.every((peerId) => sessionIds.includes(peerId))
        ? computeALGapNackRelayHops(sessionIds.length)
        : AL_GAP_NACK_RELAY_HOP_LIMIT;
}

/** The route capabilities of an RTC lane, each a pure read over the lane's observation of a message's room. */
export function createRtcInboundRoutes(
    lane: RtcInboundRouteLane,
    readObservation: (msg: ALMessage) => RtcOutboundObservation
): RtcInboundRoutes {
    const selfPeerId = lane.connectionService.input.sessionId;
    return {
        readUpstreamPeerId: (msg) => resolveRtcUpstreamPeerId(readObservation(msg), selfPeerId, msg.id.senderId),
        readGapNackRelayHops: (msg, pathPeerIds) =>
            resolveRtcGapNackRelayHops(readObservation(msg).room, [selfPeerId, msg.id.senderId, ...pathPeerIds]),
        isRoutedPeerReady: (msg, peerId) => isRtcRoutedPeerReady(readObservation(msg), peerId),
        isLayoutChildPeer: (msg, peerId) =>
            isRtcLayoutChildPeer(
                toRtcAcceptedOverlayAdjacency(readObservation(msg), selfPeerId),
                msg.id.senderId,
                peerId
            ),
        readGapNackParent: (nack) => {
            const routes = {
                rooms: lane.groupCache,
                acceptedOverlays: lane.overlayCache,
                selfPeerId,
                connectedPeerIds: lane.connectionService.readyPeerIdsForLane()
            };
            const parent = resolveRtcRelayParent(routes, nack.originPeerId, nack.fromPeerId);
            return parent === undefined
                ? undefined
                : { source: { kind: 'rtc-peer', peerId: parent.peerId }, relayHops: parent.relayHops };
        }
    };
}
