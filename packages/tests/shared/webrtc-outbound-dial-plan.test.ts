import { computeInFlightSetupCounts, computeOutboundDialPlan } from '@shared/services/webrtc-outbound-dial-plan.ts';
import { describe, expect, it } from 'vitest';

describe('computeOutboundDialPlan', () => {
    it('leaves the connection budget to new dials after the desired known peers', () => {
        const connectablePeerIds = Array.from(
            { length: 49 },
            (_, index) => `peer-${index}`
        );

        const plan = computeOutboundDialPlan({
            maxPeerConnections: 10,
            knownPeerIds: new Set(),
            livePeerIds: new Set(),
            desiredPeerIds: new Set(connectablePeerIds),
            connectablePeerIds,
            serverDesiredPeerIds: new Set()
        });

        expect(plan.livePeerIds).toEqual([]);
        expect(plan.deadKnownPeerIds).toEqual([]);
        expect(plan.candidatePeerIds).toEqual(connectablePeerIds);
        expect(plan.newDialBudget).toBe(10);
    });

    it('separates live known peers, dead known peers and new candidates, budgeting only the new ones', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 3,
            knownPeerIds: new Set(['peer-a', 'peer-b']),
            livePeerIds: new Set(['peer-a']),
            desiredPeerIds: new Set(['peer-a', 'peer-b', 'peer-c', 'peer-d']),
            connectablePeerIds: ['peer-a', 'peer-b', 'peer-c', 'peer-d'],
            serverDesiredPeerIds: new Set()
        });

        expect(plan.livePeerIds).toEqual(['peer-a']);
        expect(plan.deadKnownPeerIds).toEqual(['peer-b']);
        expect(plan.candidatePeerIds).toEqual(['peer-c', 'peer-d']);
        expect(plan.newDialBudget).toBe(1);
    });

    it('orders server-overlay-desired candidates before bootstrap candidates', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 2,
            knownPeerIds: new Set(),
            livePeerIds: new Set(),
            desiredPeerIds: new Set(['peer-boot-1', 'peer-server-1', 'peer-boot-2', 'peer-server-2']),
            connectablePeerIds: [
                'peer-boot-1',
                'peer-server-1',
                'peer-boot-2',
                'peer-server-2'
            ],
            serverDesiredPeerIds: new Set(['peer-server-1', 'peer-server-2'])
        });

        expect(plan.candidatePeerIds).toEqual(['peer-server-1', 'peer-server-2', 'peer-boot-1', 'peer-boot-2']);
        expect(plan.newDialBudget).toBe(2);
    });

    it('does not count retained undesired known peers against the budget', () => {
        const plan = computeOutboundDialPlan({
            maxPeerConnections: 2,
            knownPeerIds: new Set(['retained-1', 'retained-2', 'peer-a']),
            livePeerIds: new Set(['retained-1', 'retained-2', 'peer-a']),
            desiredPeerIds: new Set(['peer-a', 'peer-b']),
            connectablePeerIds: ['peer-a', 'peer-b'],
            serverDesiredPeerIds: new Set()
        });

        expect(plan.livePeerIds).toEqual(['peer-a']);
        expect(plan.candidatePeerIds).toEqual(['peer-b']);
        expect(plan.newDialBudget).toBe(1);
    });
});

describe('computeInFlightSetupCounts', () => {
    it('charges every in-flight setup to each group that wants the peer', () => {
        const counts = computeInFlightSetupCounts(
            ['peer-shared', 'peer-a', 'peer-unowned'],
            new Map([
                ['peer-shared', ['group-1', 'group-2']],
                ['peer-a', ['group-1']],
                ['peer-b', ['group-2']]
            ])
        );

        expect([...counts.entries()]).toEqual([['group-1', 2], ['group-2', 1]]);
    });
});
