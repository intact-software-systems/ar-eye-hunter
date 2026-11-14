import { describe, expect, it } from 'vitest';

import type { OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    computeConnectionCapSpend,
    selectGroupDialPeerIds,
    type ConnectionCapSpendInput
} from '@shared/services/webrtc-group-dial-policy.ts';

const groupRef: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'lobby' };
const localSessionId = 'session-local';

describe('selectGroupDialPeerIds', () => {
    // The discovery-holds-dials acceptance scenario: a presence-connected
    // `forming` lobby writes a bootstrap star as RTT evidence, and two
    // independent gates must each keep it from becoming a dial.
    it('dials nothing in a forming lobby holding a bootstrap star', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'forming',
            localSessionId,
            planned: createOverlay({ provenance: 'bootstrap', nextHopSessionIds: ['session-a', 'session-b'] }),
            accepted: undefined
        })).toEqual([]);
    });

    it('dials nothing in a forming lobby even when a server layout exists', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'forming',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-a'] }),
            accepted: undefined
        })).toEqual([]);
    });

    // The provenance gate alone, with the stage gate open: a bootstrap
    // overlay never substitutes for a missing server layout.
    it('refuses a bootstrap star as a substitute for the planned layout', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'connecting',
            localSessionId,
            planned: createOverlay({ provenance: 'bootstrap', nextHopSessionIds: ['session-a', 'session-b'] }),
            accepted: undefined
        })).toEqual([]);
    });

    it('dials the planned server layout while connecting', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'connecting',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-a', localSessionId, 'session-b'] }),
            accepted: undefined
        })).toEqual(['session-a', 'session-b']);
    });

    it('dials the accepted and the planned layout once each while active', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-planned'] }),
            accepted: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-accepted'] })
        })).toEqual(['session-shared', 'session-accepted', 'session-planned']);
    });

    it('dials the accepted layout and not the planned one while reconfiguring', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'reconfiguring',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-planned'] }),
            accepted: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-accepted'] })
        })).toEqual(['session-accepted']);
    });

    it('dials both layouts once each while reconnecting', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'reconnecting',
            localSessionId,
            planned: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-planned'] }),
            accepted: createOverlay({ provenance: 'server', nextHopSessionIds: ['session-shared', 'session-accepted'] })
        })).toEqual(['session-shared', 'session-accepted', 'session-planned']);
    });

    // A retired layout is a tombstone, not a peer set.
    it('refuses a removed server layout', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: undefined,
            accepted: createOverlay({ provenance: 'server', state: 'removed', nextHopSessionIds: ['session-a'] })
        })).toEqual([]);
    });

    it('dials nothing when no layout is stored', () => {
        expect(selectGroupDialPeerIds({
            lifecycleState: 'active',
            localSessionId,
            planned: undefined,
            accepted: undefined
        })).toEqual([]);
    });
});

function createOverlay(
    overrides: Partial<OverlayInfo> & Pick<OverlayInfo, 'provenance' | 'nextHopSessionIds'>
): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 4, presenceRevision: 2 },
        state: 'active',
        overlayId: 'app:workspace:lobby',
        groupRef,
        topology: 'star',
        name: 'Lobby',
        createdByClientId: 'creator',
        createdAtEpochMs: 1_000,
        degreeLimit: 8,
        overlayVersion: 1,
        updatedAtEpochMs: 1_000,
        nextHopsBySessionId: undefined,
        ...overrides
    };
}

function capInput(input: Partial<ConnectionCapSpendInput> & Pick<ConnectionCapSpendInput, 'maxPeerConnections'>): ConnectionCapSpendInput {
    return {
        knownPeerIds: new Set(),
        desiredPeerIds: new Set(),
        earlyDialPeerIds: new Set(),
        retainedPeers: [],
        candidatePeerIds: [],
        inboundPeerId: null,
        ...input
    };
}

describe('computeConnectionCapSpend', () => {
    it('an accepted peer always gets a slot: early peers close first, then the oldest retained edge', () => {
        const before = capInput({
            maxPeerConnections: 4,
            knownPeerIds: new Set(['a1', 'a2', 'c1', 'b-old', 'b-new', 'c-retained']),
            desiredPeerIds: new Set(['a1', 'a2', 'a3', 'c1']),
            earlyDialPeerIds: new Set(['c1']),
            retainedPeers: [
                { peerId: 'b-new', earlyDial: false, retainedOrder: 2 },
                { peerId: 'c-retained', earlyDial: true, retainedOrder: 3 },
                { peerId: 'b-old', earlyDial: false, retainedOrder: 1 }
            ],
            candidatePeerIds: ['a3']
        });

        const dial = computeConnectionCapSpend(before);
        expect(dial.acceptedDialBudget).toBe(2);
        expect(dial.dialPeerIds).toEqual(['a3']);

        const afterDial = computeConnectionCapSpend({
            ...before,
            knownPeerIds: new Set([...before.knownPeerIds, 'a3']),
            candidatePeerIds: []
        });
        expect(afterDial.evictPeerIds).toEqual(['c-retained', 'c1', 'b-old']);
    });

    it('an early peer is dialled only into a free slot and never closes a retained or an accepted peer', () => {
        const partial = computeConnectionCapSpend(capInput({
            maxPeerConnections: 5,
            knownPeerIds: new Set(['a1', 'b1']),
            desiredPeerIds: new Set(['a1', 'a2', 'c1', 'c2', 'c3']),
            earlyDialPeerIds: new Set(['c1', 'c2', 'c3']),
            retainedPeers: [{ peerId: 'b1', earlyDial: false, retainedOrder: 0 }],
            candidatePeerIds: ['a2', 'c1', 'c2', 'c3']
        }));
        expect(partial.dialPeerIds).toEqual(['a2', 'c1', 'c2']);
        expect(partial.deferredPeerIds).toEqual(['c3']);
        expect(partial.evictPeerIds).toEqual([]);

        const full = computeConnectionCapSpend(capInput({
            maxPeerConnections: 5,
            knownPeerIds: new Set(['a1', 'b1', 'b2', 'b3', 'b4']),
            desiredPeerIds: new Set(['a1', 'c1']),
            earlyDialPeerIds: new Set(['c1']),
            retainedPeers: ['b1', 'b2', 'b3', 'b4'].map((peerId, retainedOrder) => ({ peerId, earlyDial: false, retainedOrder })),
            candidatePeerIds: ['c1']
        }));
        expect(full.dialPeerIds).toEqual([]);
        expect(full.deferredPeerIds).toEqual(['c1']);
        expect(full.evictPeerIds).toEqual([]);
    });

    it('over the cap an early peer closes before any retained edge of a replaced layout', () => {
        const replaced = ['a1', 'a2', 'a3', 'a4', 'a5'];
        const neverPromoted = ['b1', 'b2', 'b3', 'b4', 'b5'];
        const promoted = ['c1', 'c2', 'c3', 'c4', 'c5'];

        const spend = computeConnectionCapSpend(capInput({
            maxPeerConnections: 10,
            knownPeerIds: new Set([...replaced, ...neverPromoted, ...promoted]),
            desiredPeerIds: new Set(promoted),
            retainedPeers: [
                ...replaced.map((peerId, index) => ({ peerId, earlyDial: false, retainedOrder: index })),
                ...neverPromoted.map((peerId, index) => ({ peerId, earlyDial: true, retainedOrder: 5 + index }))
            ]
        }));

        expect(spend.evictPeerIds).toEqual(neverPromoted);
    });

    it('an inbound offer from an early peer is admitted only into a free slot', () => {
        const base = capInput({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['a1', 'b1']),
            desiredPeerIds: new Set(['a1', 'c1']),
            earlyDialPeerIds: new Set(['c1']),
            retainedPeers: [{ peerId: 'b1', earlyDial: false, retainedOrder: 0 }],
            inboundPeerId: 'c1'
        });

        expect(computeConnectionCapSpend(base).inbound).toEqual({ verdict: 'admitted', closePeerIds: [] });
        expect(
            computeConnectionCapSpend({
                ...base,
                desiredPeerIds: new Set(['a1', 'a2', 'c1']),
                candidatePeerIds: ['a2']
            }).inbound
        ).toEqual({ verdict: 'held', closePeerIds: [] });
        const full = computeConnectionCapSpend({ ...base, knownPeerIds: new Set(['a1', 'b1', 'x1']) });
        expect(full.inbound).toEqual({ verdict: 'held', closePeerIds: [] });
        expect(full.evictPeerIds).toEqual([]);
    });

    it('an inbound offer from an accepted peer at a full cap closes the early peer an outbound accepted dial would, and never a retained edge', () => {
        const before = capInput({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['a1', 'c1', 'b1']),
            desiredPeerIds: new Set(['a1', 'a2', 'c1']),
            earlyDialPeerIds: new Set(['c1']),
            retainedPeers: [{ peerId: 'b1', earlyDial: false, retainedOrder: 0 }]
        });

        const inbound = computeConnectionCapSpend({ ...before, inboundPeerId: 'a2' });
        const outbound = computeConnectionCapSpend({ ...before, knownPeerIds: new Set([...before.knownPeerIds, 'a2']) });

        expect(inbound.inbound).toEqual({ verdict: 'admitted', closePeerIds: ['c1'] });
        expect(outbound.evictPeerIds).toEqual(['c1']);

        const noEarly = computeConnectionCapSpend({
            ...before,
            knownPeerIds: new Set(['a1', 'b1', 'b2']),
            desiredPeerIds: new Set(['a1', 'a2']),
            earlyDialPeerIds: new Set(),
            retainedPeers: [
                { peerId: 'b1', earlyDial: false, retainedOrder: 0 },
                { peerId: 'b2', earlyDial: false, retainedOrder: 1 }
            ],
            inboundPeerId: 'a2'
        });
        expect(noEarly.inbound).toEqual({ verdict: 'refused', closePeerIds: [] });
    });

    it('a replaced layout\'s edge that the next plan names again keeps its place among the retained edges', () => {
        const input = capInput({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['a1', 'a2', 'c1', 'x1']),
            desiredPeerIds: new Set(['a1', 'c1', 'x1']),
            earlyDialPeerIds: new Set(['a1', 'c1']),
            retainedPeers: [
                { peerId: 'a1', earlyDial: false, retainedOrder: 0 },
                { peerId: 'a2', earlyDial: false, retainedOrder: 1 }
            ]
        });

        expect(computeConnectionCapSpend(input).evictPeerIds).toEqual(['c1']);
        expect(computeConnectionCapSpend({ ...input, maxPeerConnections: 2 }).evictPeerIds).toEqual(['c1', 'a1']);
    });

    it('with no early peer the ranking is the base\'s', () => {
        const retained = [
            { peerId: 'retained-2', earlyDial: false, retainedOrder: 1 },
            { peerId: 'retained-1', earlyDial: false, retainedOrder: 0 }
        ];
        const retainedOverCap = capInput({
            maxPeerConnections: 2,
            knownPeerIds: new Set(['retained-1', 'retained-2', 'peer-a']),
            desiredPeerIds: new Set(['peer-a', 'peer-b']),
            retainedPeers: retained,
            candidatePeerIds: ['peer-b']
        });
        expect(computeConnectionCapSpend(retainedOverCap)).toEqual({
            acceptedDialBudget: 1,
            dialPeerIds: ['peer-b'],
            deferredPeerIds: [],
            evictPeerIds: ['retained-1'],
            closableEarlyPeerIds: [],
            inbound: { verdict: 'refused', closePeerIds: [] }
        });
        expect(computeConnectionCapSpend({ ...retainedOverCap, inboundPeerId: 'peer-b' }).inbound.verdict).toBe('refused');
        expect(computeConnectionCapSpend({ ...retainedOverCap, maxPeerConnections: 4, inboundPeerId: 'peer-b' }).inbound)
            .toEqual({ verdict: 'admitted', closePeerIds: [] });

        const acceptedOverCap = computeConnectionCapSpend(capInput({
            maxPeerConnections: 2,
            knownPeerIds: new Set(['retained-1', 'retained-2', 'peer-a', 'peer-b', 'peer-c']),
            desiredPeerIds: new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d']),
            retainedPeers: retained,
            candidatePeerIds: ['peer-d']
        }));
        expect(acceptedOverCap).toEqual({
            acceptedDialBudget: 0,
            dialPeerIds: ['peer-d'],
            deferredPeerIds: [],
            evictPeerIds: ['retained-1', 'retained-2'],
            closableEarlyPeerIds: [],
            inbound: { verdict: 'refused', closePeerIds: [] }
        });
    });
});
