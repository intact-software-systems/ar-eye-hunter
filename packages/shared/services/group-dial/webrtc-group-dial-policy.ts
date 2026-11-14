import type { OverlayInfo, PeerId } from '../../api/api-config.ts';
import type { GroupLifecycleState } from '../../api/group-lifecycle/group-lifecycle-policy.ts';
import { resolveDialLayoutRoles } from '../../api/group-lifecycle/resolve-dial-layout-roles.ts';

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
function selectGroupEarlyDialPeerIds(
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
