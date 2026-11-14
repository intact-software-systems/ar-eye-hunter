import type { OverlayInfo, PeerId } from '../api/api-config.ts';
import type { GroupLifecycleState } from '../api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveDialLayoutRoles } from '../api/group-lifecycle/resolve-dial-layout-roles.ts';

export interface SelectGroupDialPeerIdsInput {
    readonly lifecycleState: GroupLifecycleState;
    readonly localSessionId: PeerId;
    readonly planned: OverlayInfo | undefined;
    readonly accepted: OverlayInfo | undefined;
}

/**
 * The browser's complete missing-peer selection policy. Only authoritative
 * server layouts can create RTC peers; a local bootstrap overlay remains RTT
 * evidence and never substitutes for a missing lifecycle-selected layout.
 */
export function selectGroupDialPeerIds(
    input: SelectGroupDialPeerIdsInput
): readonly PeerId[] {
    const plannedPeerIds = serverLayoutPeerIds(
        input.planned,
        input.localSessionId
    );
    const acceptedPeerIds = serverLayoutPeerIds(
        input.accepted,
        input.localSessionId
    );

    switch (resolveDialLayoutRoles(input.lifecycleState)) {
        case 'none':
            return [];
        case 'planned':
            return plannedPeerIds;
        case 'accepted':
            return acceptedPeerIds;
        case 'accepted-and-planned':
            return [...new Set([...acceptedPeerIds, ...plannedPeerIds])];
    }
}

/**
 * The peers a room dials only because its published planned layout names them,
 * ahead of that layout's promotion. Of the stages that dial both layouts only
 * `active` dials early: `reconnecting` wants both layouts' peers as fully as the
 * accepted ones.
 */
export function selectGroupEarlyDialPeerIds(
    input: SelectGroupDialPeerIdsInput
): readonly PeerId[] {
    if (input.lifecycleState !== 'active' || resolveDialLayoutRoles(input.lifecycleState) !== 'accepted-and-planned') {
        return [];
    }
    const acceptedPeerIds = new Set(serverLayoutPeerIds(input.accepted, input.localSessionId));
    return serverLayoutPeerIds(input.planned, input.localSessionId)
        .filter((peerId) => !acceptedPeerIds.has(peerId));
}

/** The early-dial peers of every room that no room wants for any other reason. */
export function selectEarlyOnlyDialPeerIds(
    inputs: readonly SelectGroupDialPeerIdsInput[]
): ReadonlySet<PeerId> {
    const earlyPeerIds = new Set(inputs.flatMap(selectGroupEarlyDialPeerIds));
    const otherwiseDialledPeerIds = new Set(
        inputs.flatMap((input) => {
            const groupEarlyPeerIds = new Set(selectGroupEarlyDialPeerIds(input));
            return selectGroupDialPeerIds(input).filter((peerId) => !groupEarlyPeerIds.has(peerId));
        })
    );
    return new Set([...earlyPeerIds].filter((peerId) => !otherwiseDialledPeerIds.has(peerId)));
}

function serverLayoutPeerIds(
    overlay: OverlayInfo | undefined,
    localSessionId: PeerId
): readonly PeerId[] {
    if (overlay?.provenance !== 'server' || overlay.state !== 'active') {
        return [];
    }

    return overlay.nextHopSessionIds.filter(
        (peerId) => peerId !== localSessionId
    );
}

export interface CapRetainedPeer {
    readonly peerId: PeerId;
    /** The peer was wanted only for an early dial when it stopped being desired. */
    readonly earlyDial: boolean;
    readonly retainedOrder: number;
}

export interface ConnectionCapSpendInput {
    readonly maxPeerConnections: number;
    readonly knownPeerIds: ReadonlySet<PeerId>;
    readonly desiredPeerIds: ReadonlySet<PeerId>;
    /** Desired peers wanted only through an active room's planned layout. */
    readonly earlyDialPeerIds: ReadonlySet<PeerId>;
    /** Known peers kept after they stopped being desired. */
    readonly retainedPeers: readonly CapRetainedPeer[];
    /** Desired peers not yet known that this pass may dial, in dial order. */
    readonly candidatePeerIds: readonly PeerId[];
    readonly inboundPeerId: PeerId | null;
}

export interface ConnectionCapSpend {
    /** New connections accepted candidates may open; an early or a retained peer never holds one back. */
    readonly acceptedDialBudget: number;
    /** Accepted candidates in their order, then the early candidates that fit a free slot. */
    readonly dialPeerIds: readonly PeerId[];
    /** Early candidates no free slot holds; they wait for a slot to free. */
    readonly deferredPeerIds: readonly PeerId[];
    /** What closes, in close order, to bring the known peers (and the inbound one) within the cap. */
    readonly evictPeerIds: readonly PeerId[];
    /** `false` when there is no inbound offer. */
    readonly inboundAdmitted: boolean;
}

/**
 * The one ranking every spend of the peer-connection cap reads. Accepted peers always fit: they close early peers
 * first (retained ones oldest first, then desired ones), then edges retained from a replaced accepted layout, oldest
 * first. An early peer takes only a slot that is free after every known peer and every accepted candidate, and never
 * closes anything. With no early peer every answer is the cap rule that applied before early dialling.
 */
export function computeConnectionCapSpend(input: ConnectionCapSpendInput): ConnectionCapSpend {
    const isEarly = (peerId: PeerId): boolean => input.earlyDialPeerIds.has(peerId);
    const knownAcceptedCount = Array.from(input.knownPeerIds)
        .filter((peerId) => input.desiredPeerIds.has(peerId) && !isEarly(peerId))
        .length;
    const acceptedCandidates = input.candidatePeerIds.filter((peerId) => !isEarly(peerId));
    const earlyCandidates = input.candidatePeerIds.filter(isEarly);
    const freeSlotCount = Math.max(0, input.maxPeerConnections - input.knownPeerIds.size - acceptedCandidates.length);
    const inboundPeerId = input.inboundPeerId;
    const inboundAccepted = inboundPeerId !== null && input.desiredPeerIds.has(inboundPeerId) &&
        !isEarly(inboundPeerId);
    const inboundSlotCount = inboundPeerId !== null && inboundAccepted && !input.knownPeerIds.has(inboundPeerId)
        ? 1
        : 0;

    return {
        acceptedDialBudget: Math.max(0, input.maxPeerConnections - knownAcceptedCount),
        dialPeerIds: [...acceptedCandidates, ...earlyCandidates.slice(0, freeSlotCount)],
        deferredPeerIds: earlyCandidates.slice(freeSlotCount),
        evictPeerIds: computeEvictPeerIds(input, input.knownPeerIds.size + inboundSlotCount),
        inboundAdmitted: inboundAccepted || (inboundPeerId !== null && isEarly(inboundPeerId) && freeSlotCount > 0)
    };
}

function computeEvictPeerIds(input: ConnectionCapSpendInput, occupiedSlotCount: number): readonly PeerId[] {
    const overflow = occupiedSlotCount - input.maxPeerConnections;
    if (overflow <= 0) {
        return [];
    }
    const retained = input.retainedPeers
        .filter((peer) => input.knownPeerIds.has(peer.peerId) && !input.desiredPeerIds.has(peer.peerId))
        .sort((left, right) => left.retainedOrder - right.retainedOrder);
    const knownEarlyPeerIds = Array.from(input.knownPeerIds)
        .filter((peerId) => input.desiredPeerIds.has(peerId) && input.earlyDialPeerIds.has(peerId));
    return [
        ...retained.filter((peer) => peer.earlyDial).map((peer) => peer.peerId),
        ...knownEarlyPeerIds,
        ...retained.filter((peer) => !peer.earlyDial).map((peer) => peer.peerId)
    ].slice(0, overflow);
}
