import { computeOutboundDialPlan, computePacedOutboundDialPlan } from '@shared/services/webrtc-outbound-dial-plan.ts';
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

describe('computePacedOutboundDialPlan', () => {
    it('admits new dials until each owning group reaches its in-flight bound and paces the rest', () => {
        const paced = computePacedOutboundDialPlan({
            peersToConnect: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
            knownPeerIds: new Set(),
            inFlightPeerIds: new Set(),
            ownerGroupIdsByPeerId: new Map([
                ['peer-a', ['group-1']],
                ['peer-b', ['group-1']],
                ['peer-c', ['group-1']],
                ['peer-d', ['group-1']]
            ]),
            groupSetupBudgets: new Map([
                ['group-1', { desiredPeerIds: new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d']), maxConcurrentEdgeSetups: 2 }]
            ])
        });

        expect(paced.peersToConnect).toEqual(['peer-a', 'peer-b']);
        expect(paced.pacedPeerIds).toEqual(['peer-c', 'peer-d']);
    });

    it('charges setups already in flight to their owners before admitting new dials', () => {
        const paced = computePacedOutboundDialPlan({
            peersToConnect: ['peer-in-flight', 'peer-new-1', 'peer-new-2'],
            knownPeerIds: new Set(['peer-in-flight']),
            inFlightPeerIds: new Set(['peer-in-flight']),
            ownerGroupIdsByPeerId: new Map([
                ['peer-in-flight', ['group-1']],
                ['peer-new-1', ['group-1']],
                ['peer-new-2', ['group-1']]
            ]),
            groupSetupBudgets: new Map([
                ['group-1', { desiredPeerIds: new Set(['peer-in-flight', 'peer-new-1', 'peer-new-2']), maxConcurrentEdgeSetups: 2 }]
            ])
        });

        expect(paced.peersToConnect).toEqual(['peer-in-flight', 'peer-new-1']);
        expect(paced.pacedPeerIds).toEqual(['peer-new-2']);
    });

    it('lets a peer shared by two groups start only when every owner has a free slot', () => {
        const paced = computePacedOutboundDialPlan({
            peersToConnect: ['peer-a', 'peer-shared', 'peer-b'],
            knownPeerIds: new Set(),
            inFlightPeerIds: new Set(),
            ownerGroupIdsByPeerId: new Map([
                ['peer-a', ['group-saturated']],
                ['peer-shared', ['group-saturated', 'group-idle']],
                ['peer-b', ['group-idle']]
            ]),
            groupSetupBudgets: new Map([
                ['group-saturated', { desiredPeerIds: new Set(['peer-a', 'peer-shared']), maxConcurrentEdgeSetups: 1 }],
                ['group-idle', { desiredPeerIds: new Set(['peer-shared', 'peer-b']), maxConcurrentEdgeSetups: 5 }]
            ])
        });

        expect(paced.peersToConnect).toEqual(['peer-a', 'peer-b']);
        expect(paced.pacedPeerIds).toEqual(['peer-shared']);
    });

    it('never paces a peer whose setup already exists, established or not', () => {
        const paced = computePacedOutboundDialPlan({
            peersToConnect: ['peer-established', 'peer-in-flight', 'peer-new'],
            knownPeerIds: new Set(['peer-established', 'peer-in-flight']),
            inFlightPeerIds: new Set(['peer-in-flight']),
            ownerGroupIdsByPeerId: new Map([
                ['peer-established', ['group-1']],
                ['peer-in-flight', ['group-1']],
                ['peer-new', ['group-1']]
            ]),
            groupSetupBudgets: new Map([
                ['group-1', { desiredPeerIds: new Set(['peer-established', 'peer-in-flight', 'peer-new']), maxConcurrentEdgeSetups: 1 }]
            ])
        });

        expect(paced.peersToConnect).toEqual(['peer-established', 'peer-in-flight']);
        expect(paced.pacedPeerIds).toEqual(['peer-new']);
    });
});
