import type { PeerId } from '../api/api-config.ts';
import { computeConnectionCapSpend } from './webrtc-group-dial-policy.ts';

export type OutboundDialPlanInput = Readonly<{
    maxPeerConnections: number;
    knownPeerIds: ReadonlySet<PeerId>;
    /** Known peers whose native connection is still connecting or connected. */
    livePeerIds: ReadonlySet<PeerId>;
    desiredPeerIds: ReadonlySet<PeerId>;
    /** Desired peers wanted only through an active room's planned layout. */
    earlyDialPeerIds: ReadonlySet<PeerId>;
    connectablePeerIds: readonly PeerId[];
    serverDesiredPeerIds: ReadonlySet<PeerId>;
}>;

export type OutboundDialPlan = Readonly<{
    /** Their ensure starts nothing, so neither the budget nor the bound applies. */
    livePeerIds: readonly PeerId[];
    /** Known peers whose connection died: their ensure starts a new setup under the bound, on a connection slot they already hold. */
    deadKnownPeerIds: readonly PeerId[];
    /** New dials: accepted ones server-overlay-desired first, then the early ones a free slot holds; only `newDialBudget` of them start. */
    candidatePeerIds: readonly PeerId[];
    /** Early peers no free slot holds this pass. */
    deferredPeerIds: readonly PeerId[];
    newDialBudget: number;
}>;

/**
 * Orders outbound dialing under the same peer-connection budget inbound
 * admission uses, as `computeConnectionCapSpend` ranks it: retained peers and
 * early peers never hold back an accepted dial, since the eviction pass closes
 * them in the same reconcile, while an early dial only takes a slot that is
 * free after every known peer. The dial loop spends the budget and the
 * in-flight bound as it goes, so a paced peer never holds a slot a later
 * candidate could use, and a dial that starts nothing frees its slot at once.
 */
export function computeOutboundDialPlan(
    input: OutboundDialPlanInput
): OutboundDialPlan {
    const known = input.connectablePeerIds.filter((peerId) => input.knownPeerIds.has(peerId));
    const unknownPeerIds = input.connectablePeerIds.filter((peerId) => !input.knownPeerIds.has(peerId));
    const spend = computeConnectionCapSpend({
        maxPeerConnections: input.maxPeerConnections,
        knownPeerIds: input.knownPeerIds,
        desiredPeerIds: input.desiredPeerIds,
        earlyDialPeerIds: input.earlyDialPeerIds,
        retainedPeers: [],
        candidatePeerIds: [
            ...unknownPeerIds.filter((peerId) => input.serverDesiredPeerIds.has(peerId)),
            ...unknownPeerIds.filter((peerId) => !input.serverDesiredPeerIds.has(peerId))
        ],
        inboundPeerId: null
    });

    return {
        livePeerIds: known.filter((peerId) => input.livePeerIds.has(peerId)),
        deadKnownPeerIds: known.filter((peerId) => !input.livePeerIds.has(peerId)),
        candidatePeerIds: spend.dialPeerIds,
        deferredPeerIds: spend.deferredPeerIds,
        newDialBudget: spend.acceptedDialBudget
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
