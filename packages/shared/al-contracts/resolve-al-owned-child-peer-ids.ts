import type { ALMessage } from './al-contract.ts';
import type { ALMessagePlanningContext } from './al-policy.ts';

/**
 * The peers this peer owns as its children for one copy, reachable now or not: the immediate peer of a
 * unicast it does not address itself, or the overlay neighbours of a group message that are neither this
 * peer nor its sender, not already visited or excepted, in the room and in a broadcast's fixed list, and within
 * the forwarding hint when one is given. A peer that owns none is a leaf and never asks for a retransmit: the retry of a recipient
 * the origin already counted is the decision of the origin.
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
    return (context.overlayNeighborPeerIds ?? []).filter((peerId) =>
        !excludedPeerIds.has(peerId) &&
        (groupMemberPeerIds.size === 0 || groupMemberPeerIds.has(peerId)) &&
        (listedPeerIds === undefined || listedPeerIds.includes(peerId)) &&
        (hintedNextHops.size === 0 || hintedNextHops.has(peerId))
    );
}
