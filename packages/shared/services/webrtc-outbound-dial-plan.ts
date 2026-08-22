import type { PeerId } from '../api/api-config.ts';
import type { RtcGroupFormationMode } from '../rtc/group-formation-mode.ts';

export type OutboundDialPlanInput = Readonly<{
    mode: RtcGroupFormationMode;
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
 * later reconciles as slots free up. 'legacy-star' keeps the unbounded
 * pre-Phase-1 dialing.
 */
export function computeOutboundDialPlan(
    input: OutboundDialPlanInput
): OutboundDialPlan {
    if (input.mode === 'legacy-star') {
        return { peersToConnect: input.connectablePeerIds, deferredPeerIds: [] };
    }

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
