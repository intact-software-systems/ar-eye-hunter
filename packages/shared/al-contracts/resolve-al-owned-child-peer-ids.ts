import type { ALMessage } from './al-contract.ts';
import { resolveALFrozenMulticastAudience } from './al-frozen-multicast-audience.ts';
import type { ALMessagePlanningContext } from './al-policy.ts';

/** The accepted layout's whole adjacency, every session's next hops, seen from this peer. */
export interface ALAcceptedOverlayAdjacency {
    readonly selfPeerId: string;
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

/**
 * The peers this peer owns as its children for one copy, reachable now or not: the immediate peer of a
 * unicast it does not address itself, or the overlay neighbours of a group message that are neither this
 * peer nor its sender, not already visited or excepted, in the room and in a broadcast's fixed list, and within
 * the forwarding hint when one is given. A multicast frozen to its recipients keeps only the neighbours that lead to one
 * of them over the accepted layout, and a peer that is its only recipient keeps none. A peer that is no recipient and
 * whose layout leads none of its neighbours to one holds a layout that disagrees with its sender's, so it keeps every
 * neighbour. A peer that owns none is a leaf and never asks for a retransmit: the retry of a recipient the origin
 * already counted is the decision of the origin.
 */
export function resolveALOwnedChildPeerIds(
    msg: ALMessage,
    context: ALMessagePlanningContext
): readonly string[] {
    if (!msg.targets) {
        return [];
    }
    if (msg.targets.mode === 'unicast') {
        const immediatePeerId = msg.forwarding?.nextHopPeerIds?.[0] ?? msg.targets.toPeerId;
        return immediatePeerId === context.selfPeerId || immediatePeerId === context.fromPeerId
            ? []
            : [immediatePeerId];
    }
    const excludedPeerIds = new Set([
        context.selfPeerId,
        ...(context.fromPeerId === undefined ? [] : [context.fromPeerId]),
        ...msg.diagnostics?.visitedPeerIds ?? [],
        ...(msg.targets.mode === 'broadcast' ? msg.targets.exceptPeerIds ?? [] : [])
    ]);
    const groupMemberPeerIds = new Set(context.groupMemberPeerIds ?? []);
    const listedPeerIds = msg.targets.mode === 'broadcast' ? msg.targets.recipientPeerIds : undefined;
    const hintedNextHops = new Set(msg.forwarding?.nextHopPeerIds ?? []);
    const neighbourPeerIds = (context.overlayNeighborPeerIds ?? []).filter((peerId) =>
        !excludedPeerIds.has(peerId) &&
        (groupMemberPeerIds.size === 0 || groupMemberPeerIds.has(peerId)) &&
        (listedPeerIds === undefined || listedPeerIds.includes(peerId)) &&
        (hintedNextHops.size === 0 || hintedNextHops.has(peerId))
    );
    const frozen = resolveALFrozenMulticastAudience(msg.targets);
    if (frozen === undefined) {
        return neighbourPeerIds;
    }
    const towardRecipients = resolveALChildPeerIdsTowardRecipients(
        neighbourPeerIds,
        toALAcceptedOverlayAdjacency(context.selfPeerId, context.overlayNextHopsBySessionId),
        frozen.recipientPeerIds
    );
    return towardRecipients.length === 0 && !frozen.recipientPeerIds.includes(context.selfPeerId)
        ? neighbourPeerIds
        : towardRecipients;
}

/** The accepted layout seen from this peer; absent when the peer holds no accepted adjacency. */
export function toALAcceptedOverlayAdjacency(
    selfPeerId: string,
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>> | undefined
): ALAcceptedOverlayAdjacency | undefined {
    return nextHopsBySessionId === undefined ? undefined : { selfPeerId, nextHopsBySessionId };
}

/**
 * The children whose subtree, rooted away from this peer over the accepted layout, holds one of the recipients;
 * none when this peer is every recipient. Without an accepted layout, or with a recipient the layout does not place,
 * every child stays: the layout cannot prove that a pruned subtree holds none of them.
 */
export function resolveALChildPeerIdsTowardRecipients(
    childPeerIds: readonly string[],
    adjacency: ALAcceptedOverlayAdjacency | undefined,
    recipientPeerIds: readonly string[]
): readonly string[] {
    if (adjacency === undefined) {
        return childPeerIds;
    }
    const recipients = new Set(recipientPeerIds.filter((peerId) => peerId !== adjacency.selfPeerId));
    if ([...recipients].some((peerId) => !Object.hasOwn(adjacency.nextHopsBySessionId, peerId))) {
        return childPeerIds;
    }
    return childPeerIds.filter((childPeerId) => hasRecipientInSubtree(childPeerId, adjacency, recipients));
}

/** A walk that never re-enters this peer or a visited peer, so it visits each session of the layout at most once. */
function hasRecipientInSubtree(
    childPeerId: string,
    adjacency: ALAcceptedOverlayAdjacency,
    recipients: ReadonlySet<string>
): boolean {
    const visited = new Set([adjacency.selfPeerId]);
    const pending = [childPeerId];
    for (let peerId = pending.pop(); peerId !== undefined; peerId = pending.pop()) {
        if (visited.has(peerId)) {
            continue;
        }
        if (recipients.has(peerId)) {
            return true;
        }
        visited.add(peerId);
        pending.push(...(adjacency.nextHopsBySessionId[peerId] ?? []));
    }
    return false;
}
