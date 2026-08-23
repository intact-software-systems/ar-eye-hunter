import { computeOutboundDialPlan } from '@shared/services/webrtc-outbound-dial-plan.ts';
import { describe, expect, it } from 'vitest';

describe('computeOutboundDialPlan', () => {
    it('caps new dials at the connection budget and defers the rest', () => {
        const connectablePeerIds = Array.from(
            { length: 49 },
            (_, index) => `peer-${index}`
        );

        const plan = computeOutboundDialPlan({
            maxPeerConnections: 10,
            knownPeerIds: new Set(),
            desiredPeerIds: new Set(connectablePeerIds),
            connectablePeerIds,
            serverDesiredPeerIds: new Set()
        });

        expect(plan.peersToConnect).toHaveLength(10);
        expect(plan.deferredPeerIds).toHaveLength(39);
    });

    it('always ensures known desired peers and only budgets new dials', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['peer-a', 'peer-b']),
            desiredPeerIds: new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d']),
            connectablePeerIds: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
            serverDesiredPeerIds: new Set()
        });

        expect(plan.peersToConnect).toEqual(['peer-a', 'peer-b', 'peer-c']);
        expect(plan.deferredPeerIds).toEqual(['peer-d']);
    });

    it('prioritizes server-overlay-desired peers over bootstrap peers', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 2,
            knownPeerIds: new Set(),
            desiredPeerIds: new Set(['peer-boot-1', 'peer-server-1', 'peer-boot-2', 'peer-server-2']),
            connectablePeerIds: [
                'peer-boot-1',
                'peer-server-1',
                'peer-boot-2',
                'peer-server-2'
            ],
            serverDesiredPeerIds: new Set(['peer-server-1', 'peer-server-2'])
        });

        expect(plan.peersToConnect).toEqual(['peer-server-1', 'peer-server-2']);
        expect(plan.deferredPeerIds).toEqual(['peer-boot-1', 'peer-boot-2']);
    });

    it('excludes retained non-desired connections from the dial budget', () => {
        // Four retained (known, no longer desired) connections must not starve
        // the dial of a newly desired peer: the retained-eviction pass owns
        // trimming that overflow.
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 5,
            knownPeerIds: new Set(['old-a', 'old-b', 'old-c', 'old-d', 'old-e']),
            desiredPeerIds: new Set(['peer-new']),
            connectablePeerIds: ['peer-new'],
            serverDesiredPeerIds: new Set()
        });

        expect(plan.peersToConnect).toEqual(['peer-new']);
        expect(plan.deferredPeerIds).toEqual([]);
    });

    it('defers everything when desired connections already fill the budget', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 2,
            knownPeerIds: new Set(['peer-a', 'peer-b']),
            desiredPeerIds: new Set(['peer-a', 'peer-b', 'peer-c']),
            connectablePeerIds: ['peer-a', 'peer-b', 'peer-c'],
            serverDesiredPeerIds: new Set()
        });

        expect(plan.peersToConnect).toEqual(['peer-a', 'peer-b']);
        expect(plan.deferredPeerIds).toEqual(['peer-c']);
    });
});
