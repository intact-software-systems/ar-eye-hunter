import { describe, expect, it } from 'vitest';

import {
    computeConnectionCapSpend,
    type ConnectionCapSpendInput
} from '@shared/services/webrtc-group-dial-policy.ts';

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

        expect(computeConnectionCapSpend(base).inboundAdmitted).toBe(true);
        expect(
            computeConnectionCapSpend({
                ...base,
                desiredPeerIds: new Set(['a1', 'a2', 'c1']),
                candidatePeerIds: ['a2']
            }).inboundAdmitted
        ).toBe(false);
        const full = computeConnectionCapSpend({ ...base, knownPeerIds: new Set(['a1', 'b1', 'x1']) });
        expect(full.inboundAdmitted).toBe(false);
        expect(full.evictPeerIds).toEqual([]);
    });

    it('an inbound offer from an accepted peer frees a slot the way an outbound accepted dial does', () => {
        const before = capInput({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['a1', 'c1', 'b1']),
            desiredPeerIds: new Set(['a1', 'a2', 'c1']),
            earlyDialPeerIds: new Set(['c1']),
            retainedPeers: [{ peerId: 'b1', earlyDial: false, retainedOrder: 0 }]
        });

        const inbound = computeConnectionCapSpend({ ...before, inboundPeerId: 'a2' });
        const outbound = computeConnectionCapSpend({ ...before, knownPeerIds: new Set([...before.knownPeerIds, 'a2']) });

        expect(inbound.inboundAdmitted).toBe(true);
        expect(inbound.evictPeerIds).toEqual(['c1']);
        expect(outbound.evictPeerIds).toEqual(inbound.evictPeerIds);
    });

    it('with no early peer the ranking is the base\'s', () => {
        const retained = [
            { peerId: 'retained-2', earlyDial: false, retainedOrder: 1 },
            { peerId: 'retained-1', earlyDial: false, retainedOrder: 0 }
        ];
        const underCap = capInput({
            maxPeerConnections: 2,
            knownPeerIds: new Set(['retained-1', 'retained-2', 'peer-a']),
            desiredPeerIds: new Set(['peer-a', 'peer-b']),
            retainedPeers: retained,
            candidatePeerIds: ['peer-b']
        });
        expect(computeConnectionCapSpend(underCap)).toEqual({
            acceptedDialBudget: 1,
            dialPeerIds: ['peer-b'],
            deferredPeerIds: [],
            evictPeerIds: ['retained-1'],
            inboundAdmitted: false
        });
        expect(computeConnectionCapSpend({ ...underCap, inboundPeerId: 'peer-b' }).inboundAdmitted).toBe(true);

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
            inboundAdmitted: false
        });
    });
});
