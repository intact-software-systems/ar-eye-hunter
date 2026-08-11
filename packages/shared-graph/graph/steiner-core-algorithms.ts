import { VertexId, VertexSet, WeightedGraph } from '../graph-props.ts';

export const CoreSelectionAlgo = {
    MEDIAN_DISTANCE: 'MEDIAN_DISTANCE',
    AVERAGE_DISTANCE: 'AVERAGE_DISTANCE',
    CENTER_SELECTION: 'CENTER_SELECTION',
} as const;

export type CoreSelectionAlgo = (typeof CoreSelectionAlgo)[keyof typeof CoreSelectionAlgo];

type RankedNode = {
    node: VertexId;
    score: number;
};

export function findWCNodes(
    globalGraph: WeightedGraph,
    nodeSearchSet: VertexSet,
    relativeSet: VertexSet,
    excludeSet: VertexSet,
    k: number,
    algo: CoreSelectionAlgo,
): VertexId[] {
    if (k <= 0) {
        return [];
    }
    switch (algo) {
        case CoreSelectionAlgo.AVERAGE_DISTANCE:
            return kMedianNodes(
                globalGraph,
                nodeSearchSet,
                relativeSet,
                excludeSet,
                k,
            );

        case CoreSelectionAlgo.CENTER_SELECTION:
            return kCenterNodes(
                globalGraph,
                nodeSearchSet,
                relativeSet,
                excludeSet,
                k,
            );

        case CoreSelectionAlgo.MEDIAN_DISTANCE:
            return findkBestLocatedNodesNotInSetsMedian(
                globalGraph,
                nodeSearchSet,
                relativeSet,
                excludeSet,
                k,
            );

        default:
            throw new Error(`No support for ${algo}`);
    }
}

export function kMedianNodes(
    graph: WeightedGraph,
    nodeSearchSet: VertexSet,
    relativeSet: VertexSet,
    excludeSet: VertexSet,
    k: number,
): VertexId[] {
    const ranked: RankedNode[] = [];

    for (const node of nodeSearchSet) {
        let sumWeight = 0;

        for (const other of relativeSet) {
            if (node === other) continue;

            const edgeKey = graph.edge(node, other);
            if (edgeKey === undefined) continue;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            sumWeight += weight;
        }

        ranked.push({
            node,
            score: sumWeight,
        });
    }

    ranked.sort((a, b) => a.score - b.score || a.node.localeCompare(b.node));

    const selected: VertexId[] = [];
    for (const entry of ranked) {
        if (excludeSet.has(entry.node)) continue;

        selected.push(entry.node);
        if (selected.length >= k) break;
    }

    return selected;
}

export function kCenterNodes(
    graph: WeightedGraph,
    nodeSearchSet: VertexSet,
    relativeSet: VertexSet,
    excludeSet: VertexSet,
    k: number,
): VertexId[] {
    if (k <= 0 || relativeSet.size === 0) {
        return [];
    }

    const ranked: Array<{ node: VertexId; eccentricity: number }> = [];
    const expectedFullMeshEdges =
        (nodeSearchSet.size * (nodeSearchSet.size - 1)) / 2;
    const isFullMesh =
        countEdgesWithinSubset(graph, nodeSearchSet) === expectedFullMeshEdges;

    if (isFullMesh) {
        for (const node of nodeSearchSet) {
            let worstCaseDistance = 0;

            for (const other of relativeSet) {
                if (node === other) continue;

                const edgeKey = graph.edge(node, other);
                if (edgeKey === undefined) continue;

                const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
                if (weight > worstCaseDistance) {
                    worstCaseDistance = weight;
                }
            }

            ranked.push({ node, eccentricity: worstCaseDistance });
        }
    } else {
        for (const node of nodeSearchSet) {
            let worstCaseDistance = 0;

            if (graph.degree(node) > 0) {
                worstCaseDistance = eccentricityDistance(graph, relativeSet, node);
            }

            ranked.push({ node, eccentricity: worstCaseDistance });
        }
    }

    ranked.sort(
        (a, b) =>
            a.eccentricity - b.eccentricity || a.node.localeCompare(b.node),
    );

    const selected: VertexId[] = [];
    for (const entry of ranked) {
        if (excludeSet.has(entry.node)) continue;

        selected.push(entry.node);
        if (selected.length >= k) break;
    }

    return selected;
}

export function findkBestLocatedNodesNotInSetsMedian(
    graph: WeightedGraph,
    nodeSearchSet: VertexSet,
    relativeSet: VertexSet,
    excludeSet: VertexSet,
    k: number,
): VertexId[] {
    const ranked: RankedNode[] = [];

    for (const node of nodeSearchSet) {
        const weights: number[] = [];

        for (const other of relativeSet) {
            if (node === other) continue;

            const edgeKey = graph.edge(node, other);
            if (edgeKey === undefined) continue;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            weights.push(weight);
        }

        if (weights.length === 0) continue;

        weights.sort((a, b) => a - b);
        const medianIndex = Math.floor(weights.length / 2);

        ranked.push({
            node,
            score: weights[medianIndex],
        });
    }

    ranked.sort((a, b) => a.score - b.score || a.node.localeCompare(b.node));

    const selected: VertexId[] = [];
    for (const entry of ranked) {
        if (excludeSet.has(entry.node)) continue;

        selected.push(entry.node);
        if (selected.length >= k) break;
    }

    return selected;
}

function eccentricityDistance(
    graph: WeightedGraph,
    relativeSet: VertexSet,
    source: VertexId,
): number {
    const distances = dijkstraDistances(graph, relativeSet, source);

    let eccentricity = 0;
    for (const node of relativeSet) {
        const d = distances.get(node);
        if (d !== undefined && Number.isFinite(d) && d > eccentricity) {
            eccentricity = d;
        }
    }

    return eccentricity;
}

function dijkstraDistances(
    graph: WeightedGraph,
    allowed: VertexSet,
    source: VertexId,
): Map<VertexId, number> {
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of allowed) {
        distances.set(node, Number.POSITIVE_INFINITY);
    }
    distances.set(source, 0);

    const frontier = new Set<VertexId>(allowed);
    frontier.add(source);

    while (visited.size < frontier.size) {
        let current: VertexId | undefined;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (const node of frontier) {
            if (visited.has(node)) continue;

            const d = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (d < bestDistance) {
                current = node;
                bestDistance = d;
            }
        }

        if (current === undefined || !Number.isFinite(bestDistance)) {
            break;
        }

        visited.add(current);

        graph.forEachNeighbor(current, (neighbor: string) => {
            if (!frontier.has(neighbor)) return;
            if (visited.has(neighbor)) return;

            const edgeKey = graph.edge(current!, neighbor);
            if (edgeKey === undefined) return;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            const alt = bestDistance + weight;
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) {
                distances.set(neighbor, alt);
            }
        });
    }

    return distances;
}

function countEdgesWithinSubset(
    graph: WeightedGraph,
    subset: VertexSet,
): number {
    let count = 0;

    graph.forEachEdge((_edge: string, _attrs: unknown, source: string, target: string) => {
        if (subset.has(source) && subset.has(target)) {
            count += 1;
        }
    });

    return count;
}
