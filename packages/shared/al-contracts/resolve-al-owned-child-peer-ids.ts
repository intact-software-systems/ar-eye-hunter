import type { ALMessage } from './al-contract.ts';
import { resolveALFrozenMulticastAudience } from './al-frozen-multicast-audience.ts';
import type { ALMessagePlanningContext } from './al-policy.ts';

/** This peer's place in the accepted layout: the layout's whole adjacency, every session's next hops. */
export interface ALAcceptedOverlayPath {
    readonly selfPeerId: string;
    readonly nextHopsBySessionId: Readonly<Record<string, readonly string[]>>;
}

/**
 * The peers this peer owns as its children for one copy, reachable now or not: the immediate peer of a
 * unicast it does not address itself, or the overlay neighbours of a group message that are neither this
 * peer nor its sender, not already visited or excepted, in the room and in a broadcast's fixed list, and within
 * the forwarding hint when one is given. A multicast frozen to its recipients keeps only the neighbours that lead to one
 * of them over the accepted layout. A peer that owns none is a leaf and never asks for a retransmit: the retry of a
 * recipient the origin already counted is the decision of the origin.
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
    const path = context.overlayNextHopsBySessionId === undefined
        ? undefined
        : { selfPeerId: context.selfPeerId, nextHopsBySessionId: context.overlayNextHopsBySessionId };
    return resolveALChildPeerIdsTowardRecipients(neighbourPeerIds, path, frozen.recipientPeerIds);
}

/**
 * The children whose subtree, rooted away from this peer over the accepted layout, holds one of the recipients.
 * Without an accepted layout, or with a recipient the layout does not place, every child stays: the layout cannot
 * prove that a pruned subtree holds none of them.
 */
export function resolveALChildPeerIdsTowardRecipients(
    childPeerIds: readonly string[],
    path: ALAcceptedOverlayPath | undefined,
    recipientPeerIds: readonly string[]
): readonly string[] {
    const recipients = new Set(recipientPeerIds.filter((peerId) => peerId !== path?.selfPeerId));
    if (
        path === undefined || recipients.size === 0 ||
        [...recipients].some((peerId) => !Object.hasOwn(path.nextHopsBySessionId, peerId))
    ) {
        return childPeerIds;
    }
    return childPeerIds.filter((childPeerId) => computeSubtreeContainsRecipient(childPeerId, path, recipients));
}

/** A walk that never re-enters this peer or a visited peer, so it visits each session of the layout at most once. */
function computeSubtreeContainsRecipient(
    childPeerId: string,
    path: ALAcceptedOverlayPath,
    recipients: ReadonlySet<string>
): boolean {
    const visited = new Set([path.selfPeerId]);
    const pending = [childPeerId];
    for (let peerId = pending.pop(); peerId !== undefined; peerId = pending.pop()) {
        if (visited.has(peerId)) {
            continue;
        }
        if (recipients.has(peerId)) {
            return true;
        }
        visited.add(peerId);
        pending.push(...(path.nextHopsBySessionId[peerId] ?? []));
    }
    return false;
}
