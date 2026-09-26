import { AL_MESSAGE_RESOURCE_LIMITS } from '../al-contracts/al-message-resource-limits.ts';

export interface ToRtcTransportVisitedPeerIdsInput {
    /** Absent when the message has visited no peer yet. */
    readonly visitedPeerIds: readonly string[] | undefined;
    readonly selfPeerId: string;
    readonly nextHopPeerIds: readonly string[];
}

/**
 * The visited set each copy of one dispatch carries: the peers already visited, this sender, and every
 * next hop this dispatch addresses. The visited set is routing input, as the alternate-parent repair
 * already treats it: a relay never forwards to a visited peer, so it owns only the next hops its sender
 * did not already address (R-S2c-ii-8), and a sibling also listed as its neighbour is never its child.
 * The set only grows at its end, since a prepared copy must extend the visited set of its message, so
 * the entry cap drops the newest entries first.
 */
export function toRtcTransportVisitedPeerIds(input: ToRtcTransportVisitedPeerIdsInput): readonly string[] {
    return [...new Set([...input.visitedPeerIds ?? [], input.selfPeerId, ...input.nextHopPeerIds])]
        .slice(0, AL_MESSAGE_RESOURCE_LIMITS.visitedPeers);
}
