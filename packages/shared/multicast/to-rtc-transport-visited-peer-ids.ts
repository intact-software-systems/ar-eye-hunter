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
 * The incoming list is kept verbatim, repeats included, because a prepared copy must extend the visited
 * set of its message; new ids are appended once each, and past the entry cap the newest fall away.
 */
export function toRtcTransportVisitedPeerIds(input: ToRtcTransportVisitedPeerIdsInput): readonly string[] {
    const visited = input.visitedPeerIds ?? [];
    const appended = [...new Set([input.selfPeerId, ...input.nextHopPeerIds])].filter((peerId) =>
        !visited.includes(peerId)
    );
    return [...visited, ...appended].slice(0, AL_MESSAGE_RESOURCE_LIMITS.visitedPeers);
}
