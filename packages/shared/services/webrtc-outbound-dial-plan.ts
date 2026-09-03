import type { PeerId } from '../api/api-config.ts';

export type OutboundDialPlanInput = Readonly<{
    maxPeerConnections: number;
    knownPeerIds: ReadonlySet<PeerId>;
    /** Known peers whose native connection is still connecting or connected. */
    livePeerIds: ReadonlySet<PeerId>;
    desiredPeerIds: ReadonlySet<PeerId>;
    connectablePeerIds: readonly PeerId[];
    serverDesiredPeerIds: ReadonlySet<PeerId>;
}>;

export type OutboundDialPlan = Readonly<{
    /** Their ensure starts nothing, so neither the budget nor the bound applies. */
    livePeerIds: readonly PeerId[];
    /** Known peers whose connection died: their ensure starts a new setup under the bound, on a connection slot they already hold. */
    deadKnownPeerIds: readonly PeerId[];
    /** New dials, server-overlay-desired first; only `newDialBudget` of them fit the connection budget. */
    candidatePeerIds: readonly PeerId[];
    newDialBudget: number;
}>;

/**
 * Orders outbound dialing under the same peer-connection budget inbound
 * admission uses. Only desired known connections count against the budget:
 * retained (grace) connections are governed by the retained-eviction pass,
 * which trims the overflow in the same reconcile — counting them here would let
 * a full retained set starve required dials that the eviction pass would never
 * unblock. The dial loop spends the budget and the in-flight bound as it goes,
 * so a paced peer never holds a slot a later candidate could use, and a dial
 * that starts nothing frees its slot at once.
 */
export function computeOutboundDialPlan(
    input: OutboundDialPlanInput
): OutboundDialPlan {
    const known = input.connectablePeerIds.filter((peerId) => input.knownPeerIds.has(peerId));
    const newCandidates = input.connectablePeerIds.filter((peerId) => !input.knownPeerIds.has(peerId));
    const desiredKnownCount = Array.from(input.knownPeerIds)
        .filter((peerId) => input.desiredPeerIds.has(peerId))
        .length;

    return {
        livePeerIds: known.filter((peerId) => input.livePeerIds.has(peerId)),
        deadKnownPeerIds: known.filter((peerId) => !input.livePeerIds.has(peerId)),
        candidatePeerIds: [
            ...newCandidates.filter((peerId) => input.serverDesiredPeerIds.has(peerId)),
            ...newCandidates.filter((peerId) => !input.serverDesiredPeerIds.has(peerId))
        ],
        newDialBudget: Math.max(0, input.maxPeerConnections - desiredKnownCount)
    };
}

/**
 * Setups in flight per owning group (product decision 18): a shared peer is
 * one connection charged to every group that wants it.
 */
export function computeInFlightSetupCounts(
    inFlightPeerIds: readonly PeerId[],
    ownerGroupKeysByPeerId: ReadonlyMap<PeerId, readonly string[]>
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const peerId of inFlightPeerIds) {
        for (const groupKey of ownerGroupKeysByPeerId.get(peerId) ?? []) {
            counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
        }
    }
    return counts;
}
