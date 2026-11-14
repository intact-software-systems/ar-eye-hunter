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
 * A frozen multicast drops a neighbour only when no route from it to a recipient avoids this peer: over its own
 * layout, or over the union of the layouts in force when a visited path child may have been addressed over the other.
 * A recipient behind the sender in every layout in force means the layouts disagree, so every neighbour stays.
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
    const layouts = toALLayoutChildCandidates(context, isOwnable);
    const recipientPeerIds = resolveALFrozenMulticastAudience(msg.targets)?.recipientPeerIds;
    if (recipientPeerIds === undefined) {
        return [...new Set(layouts.flatMap((layout) => layout.ownablePeerIds))];
    }
    if (recipientPeerIds.length === 0) {
        return [];
    }
    const prunedPeerIds = layouts.map((layout) => resolveALLayoutPrunedPeerIds(layout, recipientPeerIds));
    const fallbackAdjacency = prunedPeerIds.includes(undefined) && layouts.length > 1 &&
            hasEveryRecipientAPathChildUnlessVisited(
                layouts,
                recipientPeerIds,
                toALOwnableNeighborPredicate(msg, context, [])
            )
        ? toALOverlapAdjacency(layouts.map((layout) => layout.adjacency))
        : undefined;
    const ownedPeerIds = layouts.flatMap((layout, index) =>
        prunedPeerIds[index] ??
            (fallbackAdjacency === undefined
                ? layout.ownablePeerIds
                : resolveALChildPeerIdsTowardRecipients(layout.ownablePeerIds, fallbackAdjacency, recipientPeerIds))
    );
    return [...new Set(ownedPeerIds)];
}

/** One layout in force: this peer's neighbours in it, those this copy may own, and its adjacency. */
interface ALLayoutChildCandidates {
    readonly neighborPeerIds: readonly string[];
    readonly ownablePeerIds: readonly string[];
    readonly adjacency: ALOverlayAdjacency | undefined;
}

function toALLayoutChildCandidates(
    context: ALMessagePlanningContext,
    isOwnable: (peerId: string) => boolean
): readonly ALLayoutChildCandidates[] {
    const layouts = [
        {
            neighborPeerIds: context.overlayNeighborPeerIds ?? [],
            nextHopsBySessionId: context.overlayNextHopsBySessionId
        },
        ...(context.previousOverlayLayout === undefined ? [] : [context.previousOverlayLayout])
    ];
    return layouts.map((layout) => ({
        neighborPeerIds: layout.neighborPeerIds,
        ownablePeerIds: layout.neighborPeerIds.filter(isOwnable),
        adjacency: toALOverlayAdjacency(context.selfPeerId, layout.nextHopsBySessionId)
    }));
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
 * One layout's children for a frozen multicast: every ownable neighbour without an adjacency, else those its adjacency
 * leads to a recipient; absent when this peer is no recipient and none of them does, which leaves the fallback to the
 * caller.
 */
function resolveALLayoutPrunedPeerIds(
    layout: ALLayoutChildCandidates,
    recipientPeerIds: readonly string[]
): readonly string[] | undefined {
    const { ownablePeerIds, adjacency } = layout;
    if (adjacency === undefined) {
        return ownablePeerIds;
    }
    const towardRecipients = resolveALChildPeerIdsTowardRecipients(ownablePeerIds, adjacency, recipientPeerIds);
    return towardRecipients.length > 0 || recipientPeerIds.includes(adjacency.selfPeerId)
        ? towardRecipients
        : undefined;
}

function hasEveryRecipientAPathChildUnlessVisited(
    layouts: readonly ALLayoutChildCandidates[],
    recipientPeerIds: readonly string[],
    isOwnableUnlessVisited: (peerId: string) => boolean
): boolean {
    return recipientPeerIds.every((recipientPeerId) =>
        layouts.some(({ neighborPeerIds, adjacency }) =>
            adjacency !== undefined &&
            neighborPeerIds.some((peerId) =>
                isOwnableUnlessVisited(peerId) && hasRecipientInSubtree(peerId, adjacency, new Set([recipientPeerId]))
            )
        )
    );
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
