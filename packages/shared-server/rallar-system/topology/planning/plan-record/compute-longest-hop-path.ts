import { computeTopologyHopLevels } from '../compute-topology-hop-levels.ts';
import type { TopologyLayoutEdges } from './compute-topology-layout-delta.ts';

export function computeLongestHopPath(layout: TopologyLayoutEdges): number {
    const neighboursOf = (sessionId: string): readonly string[] => layout.nextHopsBySessionId[sessionId] ?? [];
    const eccentricities = layout.activeSessionIds.map((sessionId) =>
        computeTopologyHopLevels(neighboursOf, sessionId).length - 1
    );
    return Math.max(0, ...eccentricities);
}
