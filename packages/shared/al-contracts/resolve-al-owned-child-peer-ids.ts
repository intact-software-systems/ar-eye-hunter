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
 * through both appears once. There a path child the visited set removes may have been addressed over the other layout,
 * so the fallback keeps only the neighbours that reach a recipient over the edges of both layouts; with one layout in
 * force it keeps every neighbour, as before.
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
    const isOwnable = toALOwnableNeighborPredicate(msg, context, msg.diagnostics?.visitedPeerIds ?? []);
    const isOwnableUnlessVisited = toALOwnableNeighborPredicate(msg, context, []);
    const recipientPeerIds = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
    const layouts = [
        {
            neighborPeerIds: context.overlayNeighborPeerIds ?? [],
            nextHopsBySessionId: context.overlayNextHopsBySessionId
        },
        ...(context.previousOverlayLayout === undefined ? [] : [context.previousOverlayLayout])
    ].map((layout): ALLayoutChildCandidates => ({
        ownablePeerIds: layout.neighborPeerIds.filter(isOwnable),
        ownableUnlessVisitedPeerIds: layout.neighborPeerIds.filter(isOwnableUnlessVisited),
        adjacency: toALOverlayAdjacency(context.selfPeerId, layout.nextHopsBySessionId)
    }));
    const layoutAdjacencies = layouts.map((layout) => layout.adjacency);
    const ownedPeerIds = layouts.flatMap((layout) =>
        resolveALLayoutChildPeerIds(layout, recipientPeerIds, layoutAdjacencies)
    );
    return [...new Set(ownedPeerIds)];
}

/** One layout's neighbours this copy may own, those it could own were none of them visited, and its adjacency. */
interface ALLayoutChildCandidates {
    readonly ownablePeerIds: readonly string[];
    readonly ownableUnlessVisitedPeerIds: readonly string[];
    readonly adjacency: ALOverlayAdjacency | undefined;
}

function toALOwnableNeighborPredicate(
    msg: ALMessage,
    context: ALMessagePlanningContext,
    visitedPeerIds: readonly string[]
): (peerId: string) => boolean {
    const excludedPeerIds = new Set([
        context.selfPeerId,
        ...(context.fromPeerId === undefined ? [] : [context.fromPeerId]),
        ...visitedPeerIds,
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

/** Both layouts' edges as one adjacency, while a replaced layout is in force and each layout carries its adjacency. */
function toALOverlapAdjacency(
    adjacencies: readonly (ALOverlayAdjacency | undefined)[]
): ALOverlayAdjacency | undefined {
    const [accepted, replaced] = adjacencies;
    if (accepted === undefined || replaced === undefined) {
        return undefined;
    }
    const sessionIds = new Set([
        ...Object.keys(accepted.nextHopsBySessionId),
        ...Object.keys(replaced.nextHopsBySessionId)
    ]);
    const nextHopsBySessionId = Object.fromEntries(
        [...sessionIds].map((sessionId) => [
            sessionId,
            [
                ...new Set([
                    ...accepted.nextHopsBySessionId[sessionId] ?? [],
                    ...replaced.nextHopsBySessionId[sessionId] ?? []
                ])
            ]
        ])
    );
    return { selfPeerId: accepted.selfPeerId, nextHopsBySessionId };
}

/**
 * One layout's children: every ownable neighbour, or for a frozen multicast those its adjacency leads to a recipient.
 * When none does only because the path to each recipient starts at a neighbour already visited, and a replaced layout
 * is in force, that neighbour may have been addressed over the other layout: then only the neighbours that reach a
 * recipient over the edges of both layouts without passing back through this peer stay.
 */
function resolveALLayoutChildPeerIds(
    layout: ALLayoutChildCandidates,
    recipientPeerIds: readonly string[] | undefined,
    layoutAdjacencies: readonly (ALOverlayAdjacency | undefined)[]
): readonly string[] {
    const { ownablePeerIds, adjacency } = layout;
    if (recipientPeerIds === undefined) {
        return ownablePeerIds;
    }
    if (recipientPeerIds.length === 0) {
        return [];
    }
    if (adjacency === undefined) {
        return ownablePeerIds;
    }
    const towardRecipients = resolveALChildPeerIdsTowardRecipients(ownablePeerIds, adjacency, recipientPeerIds);
    if (towardRecipients.length > 0 || recipientPeerIds.includes(adjacency.selfPeerId)) {
        return towardRecipients;
    }
    const overlapAdjacency = toALOverlapAdjacency(layoutAdjacencies);
    return overlapAdjacency !== undefined && isEveryRecipientBehindVisitedNeighbor(layout, adjacency, recipientPeerIds)
        ? resolveALChildPeerIdsTowardRecipients(ownablePeerIds, overlapAdjacency, recipientPeerIds)
        : ownablePeerIds;
}

function isEveryRecipientBehindVisitedNeighbor(
    layout: ALLayoutChildCandidates,
    adjacency: ALOverlayAdjacency,
    recipientPeerIds: readonly string[]
): boolean {
    return recipientPeerIds.every((recipientPeerId) => {
        const pathChildPeerIds = resolveALChildPeerIdsTowardRecipients(
            layout.ownableUnlessVisitedPeerIds,
            adjacency,
            [recipientPeerId]
        );
        return pathChildPeerIds.length > 0;
    });
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
