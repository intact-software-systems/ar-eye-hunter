import { describe, expect, it } from 'vitest';

import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import { computeGroupFormationReadiness, DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS } from '@shared/api/group-lifecycle/compute-group-formation-readiness.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

const NOW = 1_000_000;

describe('computeGroupFormationReadiness', () => {
    it('counts undirected planned edges once regardless of hop direction', () => {
        // a-b appears in both directions, a-c in one: two planned edges.
        const readiness = computeGroupFormationReadiness({
            planned: planned({ a: ['b', 'c'], b: ['a'], c: [] }),
            rttMeasurements: [],
            nowEpochMs: NOW
        });
        expect(readiness).toEqual({
            plannedEdgeCount: 2,
            observedEdgeCount: 0,
            observedRate: 0
        });
    });

    it('counts evidence in either direction toward the same edge', () => {
        const readiness = computeGroupFormationReadiness({
            planned: planned({ a: ['b', 'c'], b: [], c: [] }),
            rttMeasurements: [measurement('b', 'a', NOW - 10), measurement('a', 'b', NOW - 20)],
            nowEpochMs: NOW
        });
        expect(readiness).toEqual({
            plannedEdgeCount: 2,
            observedEdgeCount: 1,
            observedRate: 0.5
        });
    });

    it('ignores stale evidence beyond the freshness window', () => {
        const readiness = computeGroupFormationReadiness({
            planned: planned({ a: ['b'] }),
            rttMeasurements: [measurement('a', 'b', NOW - DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS - 1)],
            nowEpochMs: NOW
        });
        expect(readiness.observedEdgeCount).toBe(0);
    });

    it('honours an explicit freshness window', () => {
        const readiness = computeGroupFormationReadiness({
            planned: planned({ a: ['b'] }),
            rttMeasurements: [measurement('a', 'b', NOW - 5_000)],
            nowEpochMs: NOW,
            evidenceFreshnessMs: 4_000
        });
        expect(readiness.observedEdgeCount).toBe(0);
    });

    it('ignores evidence for unplanned edges and self-loops', () => {
        const readiness = computeGroupFormationReadiness({
            planned: planned({ a: ['b', 'a'] }),
            rttMeasurements: [measurement('a', 'z', NOW - 10), measurement('a', 'b', NOW - 10)],
            nowEpochMs: NOW
        });
        expect(readiness).toEqual({
            plannedEdgeCount: 1,
            observedEdgeCount: 1,
            observedRate: 1
        });
    });

    it('treats an edgeless or removed plan as trivially ready', () => {
        expect(
            computeGroupFormationReadiness({
                planned: planned({}),
                rttMeasurements: [],
                nowEpochMs: NOW
            }).observedRate
        ).toBe(1);
        expect(
            computeGroupFormationReadiness({
                planned: { ...planned({ a: ['b'] }), state: 'removed' },
                rttMeasurements: [measurement('a', 'b', NOW - 1)],
                nowEpochMs: NOW
            })
        ).toEqual({ plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 });
    });
});

function planned(nextHopsBySessionId: Readonly<Record<string, readonly string[]>>): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 0 },
        state: 'active',
        overlayId: 'overlay-1',
        groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' },
        name: 'Room 1',
        topology: 'mesh',
        activeSessionIds: Object.keys(nextHopsBySessionId),
        nextHopsBySessionId,
        degreeLimit: 8,
        version: 1,
        createdByClientId: 'server',
        createdAtEpochMs: NOW - 100,
        updatedAtEpochMs: NOW - 100
    };
}

function measurement(from: string, to: string, createdAtEpochMs: number): RttMeasurementInfo {
    return {
        sessionIdFrom: from,
        sessionIdTo: to,
        rttMs: 20,
        createdAtEpochMs,
        version: 1
    };
}
