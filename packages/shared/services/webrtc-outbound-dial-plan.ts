import type { GroupId, PeerId } from '../api/api-config.ts';
import { computeInFlightDialAdmission } from '../api/group-lifecycle/compute-in-flight-dial-admission.ts';

export type OutboundDialPlanInput = Readonly<{
    maxPeerConnections: number;
    knownPeerIds: ReadonlySet<PeerId>;
    desiredPeerIds: ReadonlySet<PeerId>;
    connectablePeerIds: readonly PeerId[];
    serverDesiredPeerIds: ReadonlySet<PeerId>;
}>;

export type OutboundDialPlan = Readonly<{
    peersToConnect: readonly PeerId[];
    deferredPeerIds: readonly PeerId[];
}>;

export interface GroupSetupBudget {
    readonly desiredPeerIds: ReadonlySet<PeerId>;
    readonly maxConcurrentEdgeSetups: number;
}

export interface PacedOutboundDialPlanInput {
    readonly peersToConnect: readonly PeerId[];
    readonly knownPeerIds: ReadonlySet<PeerId>;
    readonly inFlightPeerIds: ReadonlySet<PeerId>;
    readonly ownerGroupIdsByPeerId: ReadonlyMap<PeerId, readonly GroupId[]>;
    readonly groupSetupBudgets: ReadonlyMap<GroupId, GroupSetupBudget>;
}

export type PacedOutboundDialPlan = Readonly<{
    peersToConnect: readonly PeerId[];
    pacedPeerIds: readonly PeerId[];
}>;

/**
 * Bounds outbound dialing to the same peer-connection budget inbound
 * admission uses. Peers with an existing connection are always ensured (an
 * ensure is idempotent, not a new dial); new dials are admitted
 * server-overlay-desired peers first, then bootstrap-desired peers, until
 * desired connections reach the budget. Only desired known connections count
 * against the budget: retained (grace) connections are governed by the
 * retained-eviction pass, which trims the overflow in the same reconcile —
 * counting them here would let a full retained set starve required dials
 * that the eviction pass would never unblock. Deferred peers are retried by
 * later reconciles as slots free up.
 */
export function computeOutboundDialPlan(
    input: OutboundDialPlanInput
): OutboundDialPlan {
    const alreadyKnown = input.connectablePeerIds
        .filter((peerId) => input.knownPeerIds.has(peerId));
    const newCandidates = input.connectablePeerIds
        .filter((peerId) => !input.knownPeerIds.has(peerId));
    const serverFirstCandidates = [
        ...newCandidates.filter((peerId) => input.serverDesiredPeerIds.has(peerId)),
        ...newCandidates.filter((peerId) => !input.serverDesiredPeerIds.has(peerId))
    ];

    const desiredKnownCount = Array.from(input.knownPeerIds)
        .filter((peerId) => input.desiredPeerIds.has(peerId))
        .length;
    const newDialBudget = Math.max(
        0,
        input.maxPeerConnections - desiredKnownCount
    );

    return {
        peersToConnect: [
            ...alreadyKnown,
            ...serverFirstCandidates.slice(0, newDialBudget)
        ],
        deferredPeerIds: serverFirstCandidates.slice(newDialBudget)
    };
}

/**
 * The in-flight bound (product decision 18) over a budgeted dial plan. A known
 * peer passes untouched because its ensure starts nothing. A new dial is
 * admitted only while every owning group is below its bound, counting the
 * setups already in flight for that group plus the dials admitted earlier in
 * this pass; a paced peer waits for the next reconcile, which a setup ending
 * wakes.
 */
export function computePacedOutboundDialPlan(
    input: PacedOutboundDialPlanInput
): PacedOutboundDialPlan {
    const inFlightSetupCountByGroupId = new Map<GroupId, number>();
    for (const [groupId, budget] of input.groupSetupBudgets) {
        const inFlightSetupCount = Array.from(input.inFlightPeerIds)
            .filter((peerId) => budget.desiredPeerIds.has(peerId))
            .length;
        inFlightSetupCountByGroupId.set(groupId, inFlightSetupCount);
    }

    const peersToConnect: PeerId[] = [];
    const pacedPeerIds: PeerId[] = [];
    for (const peerId of input.peersToConnect) {
        if (input.knownPeerIds.has(peerId)) {
            peersToConnect.push(peerId);
            continue;
        }
        const ownerGroupIds = input.ownerGroupIdsByPeerId.get(peerId) ?? [];
        const owningGroupBudgets = ownerGroupIds.map((groupId) => ({
            inFlightSetupCount: inFlightSetupCountByGroupId.get(groupId) ?? 0,
            maxConcurrentEdgeSetups: input.groupSetupBudgets.get(groupId)?.maxConcurrentEdgeSetups ?? 0
        }));
        if (computeInFlightDialAdmission({ owningGroupBudgets }) === 'wait') {
            pacedPeerIds.push(peerId);
            continue;
        }
        peersToConnect.push(peerId);
        for (const groupId of ownerGroupIds) {
            inFlightSetupCountByGroupId.set(groupId, (inFlightSetupCountByGroupId.get(groupId) ?? 0) + 1);
        }
    }

    return { peersToConnect, pacedPeerIds };
}
