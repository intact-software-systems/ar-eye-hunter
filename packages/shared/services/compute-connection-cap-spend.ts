import type { PeerId } from '../api/api-config.ts';
import type { CapRetainedPeer } from './webrtc-group-dial-policy.ts';

export interface ConnectionCapSpendInput {
    readonly maxPeerConnections: number;
    readonly knownPeerIds: ReadonlySet<PeerId>;
    readonly desiredPeerIds: ReadonlySet<PeerId>;
    /** Desired peers wanted only through an active room's planned layout. */
    readonly earlyDialPeerIds: ReadonlySet<PeerId>;
    /** Known peers kept after they stopped being accepted. */
    readonly retainedPeers: readonly CapRetainedPeer[];
    /** Desired peers not yet known that this pass may dial, in dial order. */
    readonly candidatePeerIds: readonly PeerId[];
    readonly inboundPeerId: PeerId | null;
}

/** `held` waits for a free slot; `refused` is the cap's plain refusal. */
export type ConnectionCapInboundVerdict = 'admitted' | 'held' | 'refused';

export interface ConnectionCapInbound {
    readonly verdict: ConnectionCapInboundVerdict;
    /** Early peers to close so the offer fits. */
    readonly closePeerIds: readonly PeerId[];
}

export interface ConnectionCapSpend {
    /** New connections accepted candidates may open; an early or a retained peer never holds one back. */
    readonly acceptedDialBudget: number;
    /** Accepted candidates in their order, then the early candidates that fit a free slot. */
    readonly dialPeerIds: readonly PeerId[];
    /** Early candidates no free slot holds; they wait for a slot to free. */
    readonly deferredPeerIds: readonly PeerId[];
    /** What closes, in close order, to bring the known peers within the cap. */
    readonly evictPeerIds: readonly PeerId[];
    /** The early peers an accepted peer may close for its slot, in close order. */
    readonly closableEarlyPeerIds: readonly PeerId[];
    /** `refused` when there is no inbound offer. */
    readonly inbound: ConnectionCapInbound;
}

interface CapClosingOrder {
    /** Retained early peers oldest first, then desired early peers. */
    readonly earlyPeerIds: readonly PeerId[];
    /** Edges retained from a replaced accepted layout, oldest first, even while a planned layout names them again. */
    readonly replacedPeerIds: readonly PeerId[];
}

/**
 * The one ranking every spend of the peer-connection cap reads. Accepted peers always fit: outbound they close early
 * peers first (retained ones oldest first, then desired ones), then edges retained from a replaced accepted layout,
 * oldest first; an inbound accepted offer at a full cap closes early peers only, and is refused when there are too few.
 * An early peer takes only a slot that is free after every known peer and every accepted candidate, and never closes
 * anything. With no early peer only retained edges close, and an inbound accepted offer that would exceed the cap is
 * refused.
 */
export function computeConnectionCapSpend(input: ConnectionCapSpendInput): ConnectionCapSpend {
    const isAccepted = (peerId: PeerId): boolean =>
        input.desiredPeerIds.has(peerId) && !input.earlyDialPeerIds.has(peerId);
    const knownAcceptedCount = Array.from(input.knownPeerIds).filter(isAccepted).length;
    const acceptedCandidates = input.candidatePeerIds.filter(isAccepted);
    const earlyCandidates = input.candidatePeerIds.filter((peerId) => !isAccepted(peerId));
    const freeSlotCount = Math.max(0, input.maxPeerConnections - input.knownPeerIds.size - acceptedCandidates.length);
    const closingOrder = computeCapClosingOrder(input, isAccepted);
    const overflow = input.knownPeerIds.size - input.maxPeerConnections;

    return {
        acceptedDialBudget: Math.max(0, input.maxPeerConnections - knownAcceptedCount),
        dialPeerIds: [...acceptedCandidates, ...earlyCandidates.slice(0, freeSlotCount)],
        deferredPeerIds: earlyCandidates.slice(freeSlotCount),
        evictPeerIds: overflow <= 0
            ? []
            : [...closingOrder.earlyPeerIds, ...closingOrder.replacedPeerIds].slice(0, overflow),
        closableEarlyPeerIds: closingOrder.earlyPeerIds,
        inbound: computeCapInbound({ input, isAccepted, freeSlotCount, closingOrder })
    };
}

interface CapInboundInput {
    readonly input: ConnectionCapSpendInput;
    readonly isAccepted: (peerId: PeerId) => boolean;
    readonly freeSlotCount: number;
    readonly closingOrder: CapClosingOrder;
}

function computeCapInbound(inbound: CapInboundInput): ConnectionCapInbound {
    const { input } = inbound;
    const inboundPeerId = input.inboundPeerId;
    if (inboundPeerId === null || !input.desiredPeerIds.has(inboundPeerId)) {
        return { verdict: 'refused', closePeerIds: [] };
    }
    if (!inbound.isAccepted(inboundPeerId)) {
        return { verdict: inbound.freeSlotCount > 0 ? 'admitted' : 'held', closePeerIds: [] };
    }
    const overflow = input.knownPeerIds.size + (input.knownPeerIds.has(inboundPeerId) ? 0 : 1) -
        input.maxPeerConnections;
    if (overflow <= 0) {
        return { verdict: 'admitted', closePeerIds: [] };
    }
    return inbound.closingOrder.earlyPeerIds.length >= overflow
        ? { verdict: 'admitted', closePeerIds: inbound.closingOrder.earlyPeerIds.slice(0, overflow) }
        : { verdict: 'refused', closePeerIds: [] };
}

function computeCapClosingOrder(
    input: ConnectionCapSpendInput,
    isAccepted: (peerId: PeerId) => boolean
): CapClosingOrder {
    const retained = input.retainedPeers
        .filter((peer) => input.knownPeerIds.has(peer.peerId) && !isAccepted(peer.peerId))
        .sort((left, right) => left.retainedOrder - right.retainedOrder);
    const retainedPeerIds = new Set(retained.map((peer) => peer.peerId));
    const knownEarlyPeerIds = Array.from(input.knownPeerIds)
        .filter((peerId) =>
            input.desiredPeerIds.has(peerId) && input.earlyDialPeerIds.has(peerId) && !retainedPeerIds.has(peerId)
        );
    return {
        earlyPeerIds: [...retained.filter((peer) => peer.earlyDial).map((peer) => peer.peerId), ...knownEarlyPeerIds],
        replacedPeerIds: retained.filter((peer) => !peer.earlyDial).map((peer) => peer.peerId)
    };
}
