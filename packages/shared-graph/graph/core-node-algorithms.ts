import {
    compareVertexIds,
    VertexArray,
    VertexId,
    VertexSet,
    WeightedGraph,
} from '../graph-props.ts';

type RankedNode = {
    node: VertexId;
    score: number;
};

export function kBestLocatedNodesFromGraphAverage(
    graph: WeightedGraph,
    k: number,
): VertexArray {
    return kBestLocatedNodesFromVertexSubsetAverage(
        graph,
        new Set(graph.nodes() as string[]),
        k,
    );
}

export function kBestLocatedNodesFromVertexSubsetAverage(
    graph: WeightedGraph,
    vertices: VertexSet,
    k: number,
): VertexArray {
    const ranked: RankedNode[] = [];

    for (const node of vertices) {
        let sumWeight = 0;
        let degree = 0;

        graph.forEachNeighbor(node, (neighbor: string) => {
            if (!vertices.has(neighbor)) return;

            const edgeKey = graph.edge(node, neighbor);
            if (edgeKey === undefined) return;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            sumWeight += weight;
            degree += 1;
        });

        if (degree > 0) {
            ranked.push({
                node,
                score: sumWeight / degree,
            });
        }
    }

    ranked.sort(compareRankedNodesAsc);
    return ranked.slice(0, k).map(entry => entry.node);
}

export function kBestLocatedNodesFromGraphMedian(
    graph: WeightedGraph,
    k: number,
): VertexArray {
    return kBestLocatedNodesFromVertexSubsetMedian(
        graph,
        new Set(graph.nodes() as string[]),
        k,
    );
}

export function kBestLocatedNodesFromVertexSubsetMedian(
    graph: WeightedGraph,
    vertices: VertexSet,
    k: number,
): VertexArray {
    const ranked: RankedNode[] = [];

    for (const node of vertices) {
        const weights = sortedIncidentWeights(graph, node, vertices);
        if (weights.length === 0) continue;

        const medianIndex = Math.floor(weights.length / 2);
        ranked.push({
            node,
            score: weights[medianIndex],
        });
    }

    ranked.sort(compareRankedNodesAsc);
    return ranked.slice(0, k).map(entry => entry.node);
}

export function kCenterNodes(
    graph: WeightedGraph,
    vertices: VertexSet,
    k: number,
): VertexArray {
    const ranked: RankedNode[] = [];
    const vertexList = [...vertices];
    const expectedFullMeshEdges = (vertexList.length * (vertexList.length - 1)) / 2;
    const isFullMesh = countEdgesWithinSubset(graph, vertices) === expectedFullMeshEdges;

    if (isFullMesh) {
        for (const node of vertexList) {
            let worstCaseDistance = 0;

            for (const other of vertexList) {
                if (node === other) continue;

                const edgeKey = graph.edge(node, other);
                if (edgeKey === undefined) continue;

                const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
                if (weight > worstCaseDistance) {
                    worstCaseDistance = weight;
                }
            }

            ranked.push({
                node,
                score: worstCaseDistance,
            });
        }
    } else {
        for (const node of vertexList) {
            let worstCaseDistance = 0;

            if (degreeWithinSubset(graph, node, vertices) > 0) {
                worstCaseDistance = eccentricityDistance(graph, vertices, node);
            }

            ranked.push({
                node,
                score: worstCaseDistance,
            });
        }
    }

    ranked.sort(compareRankedNodesAsc);
    return ranked.slice(0, k).map(entry => entry.node);
}

export function eccentricityDistance(
    graph: WeightedGraph,
    vertices: VertexSet,
    source: VertexId,
): number {
    const distances = dijkstraDistances(graph, vertices, source);

    let eccentricity = 0;
    for (const node of vertices) {
        const d = distances.get(node);
        if (d !== undefined && Number.isFinite(d) && d > eccentricity) {
            eccentricity = d;
        }
    }

    return eccentricity;
}

export function dijkstraDistances(
    graph: WeightedGraph,
    vertices: VertexSet,
    source: VertexId,
): Map<VertexId, number> {
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of vertices) {
        distances.set(node, Number.POSITIVE_INFINITY);
    }
    distances.set(source, 0);

    while (visited.size < vertices.size) {
        let current: VertexId | undefined;
        let currentDistance = Number.POSITIVE_INFINITY;

        for (const node of vertices) {
            if (visited.has(node)) continue;

            const distance = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (distance < currentDistance) {
                current = node;
                currentDistance = distance;
            }
        }

        if (current === undefined || !Number.isFinite(currentDistance)) {
            break;
        }

        visited.add(current);

        graph.forEachNeighbor(current, (neighbor: string) => {
            if (!vertices.has(neighbor)) return;
            if (visited.has(neighbor)) return;

            const edgeKey = graph.edge(current!, neighbor);
            if (edgeKey === undefined) return;

            const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
            const alt = currentDistance + weight;
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) {
                distances.set(neighbor, alt);
            }
        });
    }

    return distances;
}

function sortedIncidentWeights(
    graph: WeightedGraph,
    node: VertexId,
    allowedVertices: VertexSet,
): number[] {
    const weights: number[] = [];

    graph.forEachNeighbor(node, (neighbor: string) => {
        if (!allowedVertices.has(neighbor)) return;

        const edgeKey = graph.edge(node, neighbor);
        if (edgeKey === undefined) return;

        const weight = graph.getEdgeAttribute(edgeKey, 'weight') as number;
        weights.push(weight);
    });

    weights.sort((a, b) => a - b);
    return weights;
}

function degreeWithinSubset(
    graph: WeightedGraph,
    node: VertexId,
    vertices: VertexSet,
): number {
    let degree = 0;

    graph.forEachNeighbor(node, (neighbor: string) => {
        if (vertices.has(neighbor)) {
            degree += 1;
        }
    });

    return degree;
}

function countEdgesWithinSubset(
    graph: WeightedGraph,
    vertices: VertexSet,
): number {
    let count = 0;

    graph.forEachEdge((edge: string, attrs: unknown, source: string, target: string) => {
        void edge;
        void attrs;

        if (vertices.has(source) && vertices.has(target)) {
            count += 1;
        }
    });

    return count;
}

function compareRankedNodesAsc(a: RankedNode, b: RankedNode): number {
    if (a.score !== b.score) {
        return a.score - b.score;
    }

    return compareVertexIds(a.node, b.node);
}
