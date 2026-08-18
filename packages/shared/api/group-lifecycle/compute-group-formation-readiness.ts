import type { RttMeasurementInfo } from '../api-config.ts';
import type { RallarOverlayTopologySnapshot } from '../overlay-topology.ts';

/**
 * Evidence stays valid this long after its sample time. A server default, not
 * yet a policy knob: the presets' establishment deadlines are 20-30s, so
 * evidence twice that old says nothing about whether the mesh is ready now.
 */
export const DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS = 60_000;

export type GroupFormationReadiness = Readonly<{
    plannedEdgeCount: number;
    observedEdgeCount: number;
    /** observed / planned; a plan with no edges is trivially ready (rate 1). */
    observedRate: number;
}>;

/**
 * The fraction of planned overlay edges with fresh RTT evidence. Pure
 * observation: it feeds the activation criterion and the read surface, and
 * decides nothing itself -- intent stays authoritative. Edges are undirected;
 * evidence in either direction counts once.
 */
export function computeGroupFormationReadiness(input: Readonly<{
    planned: RallarOverlayTopologySnapshot;
    rttMeasurements: readonly RttMeasurementInfo[];
    nowEpochMs: number;
    evidenceFreshnessMs?: number;
}>): GroupFormationReadiness {
    const plannedEdges = collectPlannedEdges(input.planned);
    if (plannedEdges.size === 0) {
        return { plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 };
    }
    const freshnessMs = input.evidenceFreshnessMs ?? DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS;
    const freshAfterEpochMs = input.nowEpochMs - freshnessMs;
    const observed = new Set<string>();
    for (const measurement of input.rttMeasurements) {
        if (measurement.createdAtEpochMs < freshAfterEpochMs) continue;
        const key = toUndirectedEdgeKey(measurement.sessionIdFrom, measurement.sessionIdTo);
        if (plannedEdges.has(key)) observed.add(key);
    }
    return {
        plannedEdgeCount: plannedEdges.size,
        observedEdgeCount: observed.size,
        observedRate: observed.size / plannedEdges.size,
    };
}

function collectPlannedEdges(planned: RallarOverlayTopologySnapshot): ReadonlySet<string> {
    const edges = new Set<string>();
    if (planned.state === 'removed') return edges;
    for (const [sessionId, hops] of Object.entries(planned.nextHopsBySessionId)) {
        for (const hop of hops) {
            if (hop === sessionId) continue;
            edges.add(toUndirectedEdgeKey(sessionId, hop));
        }
    }
    return edges;
}

function toUndirectedEdgeKey(a: string, b: string): string {
    return a < b ? `${a} ${b}` : `${b} ${a}`;
}
