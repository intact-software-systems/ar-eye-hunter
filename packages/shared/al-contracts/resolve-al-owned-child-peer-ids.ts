import type { ALMessage } from './al-contract.ts';
import { resolveALFrozenMulticastAudience } from './al-frozen-multicast-audience.ts';
import type { ALMessagePlanningContext } from './al-policy.ts';

/** A layout's whole adjacency, every session's next hops, seen from this peer. */
export interface ALOverlayAdjacency {
    readonly selfPeerId: string;
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

/**
 * The layout an accepted layout replaced, for the first half of the overlap its receivers admit: this peer's neighbours
 * in it and its whole adjacency.
 */
export interface ALPreviousOverlayLayout {
    readonly neighborPeerIds: readonly string[];
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>> | undefined;
}

/**
 * The peers this peer owns as its children for one copy, reachable now or not: the immediate peer of a
 * unicast it does not address itself, or the overlay neighbours of a group message that are neither this
 * peer nor its sender, not already visited or excepted, in the room and in a broadcast's fixed list, and within
 * the forwarding hint when one is given. A multicast frozen to its recipients keeps only the neighbours that lead to one
 * of them over their layout's adjacency; a peer that is its only recipient, or holds an audience frozen to nobody, keeps
 * none. A peer that is no recipient and whose layout leads none of its neighbours to one holds a layout that disagrees
 * with its sender's, so it keeps every neighbour. That fallback cascades: once one peer keeps every neighbour (no adjacency, an unplaced recipient, or a
 * path child its room, hint or visited set removes), each relay below it with a consistent layout sees every recipient
 * behind its sender and keeps every neighbour too, so one disagreement floods that whole subtree as before the
 * adjacency was kept, still at least once. A peer that owns none is a leaf and never asks for a retransmit: the retry of a recipient the origin
 * already counted is the decision of the origin. In the first half of a replaced layout's overlap, its children
 * follow the accepted layout's, each layout's neighbours pruned over that layout's own adjacency, and a peer owned
 * through both appears once.
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
    const isOwnable = toALOwnableNeighborPredicate(msg, context);
    const recipientPeerIds = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
    const layouts = [
        {
            neighborPeerIds: context.overlayNeighborPeerIds ?? [],
            nextHopsBySessionId: context.overlayNextHopsBySessionId
        },
        ...(context.previousOverlayLayout === undefined ? [] : [context.previousOverlayLayout])
    ];
    const ownedPeerIds = layouts.flatMap((layout) =>
        resolveALLayoutChildPeerIds(
            layout.neighborPeerIds.filter(isOwnable),
            toALOverlayAdjacency(context.selfPeerId, layout.nextHopsBySessionId),
            recipientPeerIds
        )
    );
    return [...new Set(ownedPeerIds)];
}

function toALOwnableNeighborPredicate(
    msg: ALMessage,
    context: ALMessagePlanningContext
): (peerId: string) => boolean {
    const excludedPeerIds = new Set([
        context.selfPeerId,
        ...(context.fromPeerId === undefined ? [] : [context.fromPeerId]),
        ...msg.diagnostics?.visitedPeerIds ?? [],
        ...(msg.targets?.mode === 'broadcast' ? msg.targets.exceptPeerIds ?? [] : [])
    ]);
    const groupMemberPeerIds = new Set(context.groupMemberPeerIds ?? []);
    const listedPeerIds = msg.targets?.mode === 'broadcast' ? msg.targets.recipientPeerIds : undefined;
    const hintedNextHops = new Set(msg.forwarding?.nextHopPeerIds ?? []);
    return (peerId) =>
        !excludedPeerIds.has(peerId) &&
        (groupMemberPeerIds.size === 0 || groupMemberPeerIds.has(peerId)) &&
        (listedPeerIds === undefined || listedPeerIds.includes(peerId)) &&
        (hintedNextHops.size === 0 || hintedNextHops.has(peerId));
}

/** One layout's children: every ownable neighbour, or for a frozen multicast those its adjacency leads to a recipient. */
function resolveALLayoutChildPeerIds(
    neighborPeerIds: readonly string[],
    adjacency: ALOverlayAdjacency | undefined,
    recipientPeerIds: readonly string[] | undefined
): readonly string[] {
    if (recipientPeerIds === undefined) {
        return neighborPeerIds;
    }
    if (recipientPeerIds.length === 0) {
        return [];
    }
    if (adjacency === undefined) {
        return neighborPeerIds;
    }
    const towardRecipients = resolveALChildPeerIdsTowardRecipients(neighborPeerIds, adjacency, recipientPeerIds);
    return towardRecipients.length === 0 && !recipientPeerIds.includes(adjacency.selfPeerId)
        ? neighborPeerIds
        : towardRecipients;
}

/** A layout's adjacency seen from this peer; absent when the layout carries none. */
export function toALOverlayAdjacency(
    selfPeerId: string,
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>> | undefined
): ALOverlayAdjacency | undefined {
    return nextHopsBySessionId === undefined ? undefined : { selfPeerId, nextHopsBySessionId };
}

/**
 * The children whose subtree, rooted away from this peer over the adjacency the caller passes, holds one of the
 * recipients; none when this peer is every recipient. Without an adjacency, or with a recipient the adjacency does not
 * place, every child stays: the layout cannot prove that a pruned subtree holds none of them.
 */
export function resolveALChildPeerIdsTowardRecipients(
    childPeerIds: readonly string[],
    adjacency: ALOverlayAdjacency | undefined,
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
    adjacency: ALOverlayAdjacency,
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
