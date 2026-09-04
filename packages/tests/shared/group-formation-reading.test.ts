import { describe, expect, it } from 'vitest';

import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import {
    computeGroupFormationReading,
    DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS
} from '@shared/api/group-lifecycle/compute-group-formation-reading.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

const NOW = 1_000_000;

describe('computeGroupFormationReading', () => {
    it('counts undirected planned edges once regardless of hop direction', () => {
        // a-b appears in both directions, a-c in one: two planned edges.
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b', 'c'], b: ['a'], c: [] }),
            rttMeasurements: [],
            nowEpochMs: NOW
        });
        expect(reading).toEqual({
            readiness: { plannedEdgeCount: 2, observedEdgeCount: 0, observedRate: 0 },
            evidenceWatermark: null
        });
    });

    it('counts evidence in either direction toward the same edge', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b', 'c'], b: [], c: [] }),
            rttMeasurements: [measurement('b', 'a', NOW - 10), measurement('a', 'b', NOW - 20)],
            nowEpochMs: NOW
        });
        expect(reading).toEqual({
            readiness: { plannedEdgeCount: 2, observedEdgeCount: 1, observedRate: 0.5 },
            // Both samples cover the one observed edge; the newer instant wins
            // at equal version.
            evidenceWatermark: { version: 1, createdAtEpochMs: NOW - 10 }
        });
    });

    it('ignores stale evidence beyond the freshness window', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b'] }),
            rttMeasurements: [measurement('a', 'b', NOW - DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS - 1)],
            nowEpochMs: NOW
        });
        expect(reading.readiness.observedEdgeCount).toBe(0);
    });

    it('honours an explicit freshness window', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b'] }),
            rttMeasurements: [measurement('a', 'b', NOW - 5_000)],
            nowEpochMs: NOW,
            evidenceFreshnessMs: 4_000
        });
        expect(reading.readiness.observedEdgeCount).toBe(0);
    });

    it('ignores evidence for unplanned edges and self-loops', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b', 'a'] }),
            rttMeasurements: [measurement('a', 'z', NOW - 10), measurement('a', 'b', NOW - 10)],
            nowEpochMs: NOW
        });
        expect(reading).toEqual({
            readiness: { plannedEdgeCount: 1, observedEdgeCount: 1, observedRate: 1 },
            evidenceWatermark: { version: 1, createdAtEpochMs: NOW - 10 }
        });
    });

    it('treats an edgeless or removed plan as trivially ready', () => {
        expect(
            computeGroupFormationReading({
                planned: planned({}),
                rttMeasurements: [],
                nowEpochMs: NOW
            }).readiness.observedRate
        ).toBe(1);
        expect(
            computeGroupFormationReading({
                planned: { ...planned({ a: ['b'] }), state: 'removed' },
                rttMeasurements: [measurement('a', 'b', NOW - 1)],
                nowEpochMs: NOW
            })
        ).toEqual({
            readiness: { plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 },
            evidenceWatermark: null
        });
    });
});

describe('the evidence watermark', () => {
    // RTT writes never advance the group's causal tuple, so the watermark is
    // the only fact that orders two readings of one layout.
    it('takes the highest version among the evidence it counted', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b', 'c'], b: [], c: [] }),
            rttMeasurements: [
                { ...measurement('a', 'b', NOW - 10), version: 7 },
                { ...measurement('a', 'c', NOW - 5), version: 3 }
            ],
            nowEpochMs: NOW
        });

        expect(reading.evidenceWatermark).toEqual({ version: 7, createdAtEpochMs: NOW - 10 });
    });

    // A sample for an edge outside the plan says nothing about that plan, so
    // it must not make a stale reading look fresh.
    it('ignores evidence the reading did not count', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b'], b: [] }),
            rttMeasurements: [
                { ...measurement('a', 'b', NOW - 100), version: 2 },
                { ...measurement('y', 'z', NOW - 1), version: 99 }
            ],
            nowEpochMs: NOW
        });

        expect(reading.evidenceWatermark).toEqual({ version: 2, createdAtEpochMs: NOW - 100 });
    });

    it('reports no watermark when stale evidence leaves nothing counted', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b'], b: [] }),
            rttMeasurements: [measurement('a', 'b', NOW - DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS - 1)],
            nowEpochMs: NOW
        });

        expect(reading.evidenceWatermark).toBeNull();
        expect(reading.readiness.observedEdgeCount).toBe(0);
    });

    // The published shape is the writer's guard: a reading is nested so that
    // serializing `readiness` cannot carry the watermark onto the response.
    it('keeps the watermark out of the published readiness', () => {
        const reading = computeGroupFormationReading({
            planned: planned({ a: ['b'], b: [] }),
            rttMeasurements: [measurement('a', 'b', NOW - 10)],
            nowEpochMs: NOW
        });

        expect(Object.keys(reading.readiness).sort()).toEqual([
            'observedEdgeCount',
            'observedRate',
            'plannedEdgeCount'
        ]);
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
