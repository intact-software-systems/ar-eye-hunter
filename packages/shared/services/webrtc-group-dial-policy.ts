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
    /** `refused` when there is no inbound offer. */
    readonly inbound: ConnectionCapInbound;
}

export interface RetentionsEndedByDesireInput {
    readonly desiredPeerIds: ReadonlySet<PeerId>;
    readonly earlyDialPeerIds: ReadonlySet<PeerId>;
    readonly retainedPeerConnections: ReadonlyMap<
        PeerId,
        CapRetainedPeer & { readonly expiresAtEpochMs: number | null; }
    >;
    readonly nowEpochMs: number;
}

/**
 * The retentions that end because their peer is desired again. A replaced accepted layout's edge that a planned layout
 * names again keeps its retention, and so its rank, until its grace ends; it then stays connected as an early peer.
 */
export function selectRetentionsEndedByDesire(input: RetentionsEndedByDesireInput): readonly PeerId[] {
    return Array.from(input.desiredPeerIds).filter((peerId) => {
        const retained = input.retainedPeerConnections.get(peerId);
        const replacedEdgeInGrace = retained !== undefined && !retained.earlyDial &&
            (retained.expiresAtEpochMs ?? 0) > input.nowEpochMs;
        return !(replacedEdgeInGrace && input.earlyDialPeerIds.has(peerId));
    });
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
 * oldest first; an inbound accepted offer at a full cap closes early peers only, and is refused as before when there
 * are too few. An early peer takes only a slot that is free after every known peer and every accepted candidate, and
 * never closes anything. With no early peer every answer is the cap rule that applied before early dialling.
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
