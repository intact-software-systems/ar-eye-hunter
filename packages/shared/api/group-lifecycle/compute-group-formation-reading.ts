import type { RttMeasurementInfo } from '../api-config.ts';
import type { RallarOverlayTopologySnapshot } from '../overlay-topology.ts';

/**
 * Evidence stays valid this long after its sample time. A server default, not
 * yet a policy knob: the presets' establishment deadlines are 20-30s, so
 * evidence twice that old says nothing about whether the mesh is ready now.
 */
export const DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS = 60_000;

/**
 * The published coverage fraction. This is the shape the formation view
 * serializes, so it carries observation an application can act on and none
 * of the machinery a writer needs to order two readings.
 */
export type GroupFormationReadiness = Readonly<{
    plannedEdgeCount: number;
    observedEdgeCount: number;
    /** observed / planned; a plan with no edges is trivially ready (rate 1). */
    observedRate: number;
}>;

/**
 * The newest measurement a reading counted, ordered by version first: two
 * samples of one edge share a timestamp far more often than a version, and
 * the version is the monotonic fact the RTT writer owns.
 */
export type GroupEvidenceWatermark = Readonly<{
    version: number;
    createdAtEpochMs: number;
}>;

/**
 * One measurement of a layout: what an application may see, and beside it the
 * recency signal only a writer uses (product decision 33). RTT writes never
 * advance the group's causal tuple, so that tuple cannot order two readings
 * of the same layout; the watermark can, and a status write carries it to
 * prove the evidence it decided on is newer than the evidence recorded.
 *
 * The two are nested rather than flat so that publishing a reading means
 * publishing `readiness` and cannot silently widen the response.
 */
export type GroupFormationReading = Readonly<{
    readiness: GroupFormationReadiness;
    evidenceWatermark: GroupEvidenceWatermark | null;
}>;

/** The runtime key registry the persistence and wire validators check against. */
export const GROUP_EVIDENCE_WATERMARK_KEYS = [
    'version',
    'createdAtEpochMs'
] as const satisfies readonly (keyof GroupEvidenceWatermark)[];

/** Later of two watermarks, by version then sample instant. */
export function resolveNewerEvidenceWatermark(
    left: GroupEvidenceWatermark | null,
    right: GroupEvidenceWatermark | null
): GroupEvidenceWatermark | null {
    if (left === null || right === null) {
        return left ?? right;
    }
    if (left.version !== right.version) {
        return left.version > right.version ? left : right;
    }
    return left.createdAtEpochMs >= right.createdAtEpochMs ? left : right;
}

/**
 * The fraction of planned overlay edges with fresh RTT evidence, and the
 * newest evidence that fraction counted. Pure observation: it feeds the
 * activation criterion and the read surface, and decides nothing itself --
 * intent stays authoritative. Edges are undirected; evidence in either
 * direction counts once.
 */
export function computeGroupFormationReading(
    input: Readonly<{
        planned: RallarOverlayTopologySnapshot;
        rttMeasurements: readonly RttMeasurementInfo[];
        nowEpochMs: number;
        evidenceFreshnessMs?: number;
    }>
): GroupFormationReading {
    const plannedEdges = collectPlannedEdges(input.planned);
    if (plannedEdges.size === 0) {
        return {
            readiness: { plannedEdgeCount: 0, observedEdgeCount: 0, observedRate: 1 },
            evidenceWatermark: null
        };
    }
    const freshnessMs = input.evidenceFreshnessMs ?? DEFAULT_FORMATION_EVIDENCE_FRESHNESS_MS;
    const freshAfterEpochMs = input.nowEpochMs - freshnessMs;
    const observed = new Set<string>();
    let evidenceWatermark: GroupEvidenceWatermark | null = null;
    for (const measurement of input.rttMeasurements) {
        if (measurement.createdAtEpochMs < freshAfterEpochMs) {
            continue;
        }
        const key = toUndirectedEdgeKey(measurement.sessionIdFrom, measurement.sessionIdTo);
        if (!plannedEdges.has(key)) {
            continue;
        }
        observed.add(key);
        // Only evidence this reading counted moves the watermark: a
        // measurement for an edge outside the plan says nothing about it.
        evidenceWatermark = resolveNewerEvidenceWatermark(evidenceWatermark, {
            version: measurement.version,
            createdAtEpochMs: measurement.createdAtEpochMs
        });
    }
    return {
        readiness: {
            plannedEdgeCount: plannedEdges.size,
            observedEdgeCount: observed.size,
            observedRate: observed.size / plannedEdges.size
        },
        evidenceWatermark
    };
}

function collectPlannedEdges(planned: RallarOverlayTopologySnapshot): ReadonlySet<string> {
    const edges = new Set<string>();
    if (planned.state === 'removed') {
        return edges;
    }
    for (const [sessionId, hops] of Object.entries(planned.nextHopsBySessionId)) {
        for (const hop of hops) {
            if (hop === sessionId) {
                continue;
            }
            edges.add(toUndirectedEdgeKey(sessionId, hop));
        }
    }
    return edges;
}

function toUndirectedEdgeKey(a: string, b: string): string {
    return a < b ? `${a} ${b}` : `${b} ${a}`;
}
