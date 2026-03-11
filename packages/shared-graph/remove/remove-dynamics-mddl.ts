import { VertexId, VertexState, VertexType, WeightedGraph } from '../graph-props.ts';
import { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';
import { degreeLimitOf, degreeOf, edgeWeightOf, neighborsOf, } from './remove-dynamics-helpers.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export type SelectSteinerCandidate = (
    ctx: RemoveDynamicsContext,
    adjacent: ReadonlySet<VertexId>,
) => VertexId | undefined;

export function rvTryReplaceNaive(
    ctx: RemoveDynamicsContext,
    selectSteinerCandidate?: SelectSteinerCandidate,
): RemoveResult {
    const actionDegree = degreeOf(ctx.groupGraph, ctx.actionVertexId);

    if (actionDegree <= 1) {
        const next = cloneGraph(ctx.groupGraph);
        if (next.hasNode(ctx.actionVertexId)) {
            next.dropNode(ctx.actionVertexId);
        }
        return { graph: next, changed: true };
    }

    if (actionDegree === 2) {
        return rvODTwoLocal(ctx);
    }

    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));

    let interVertex: VertexId | undefined;
    let bestNeighborSum = Number.POSITIVE_INFINITY;
    let steinerSum = 0;
    let actionSum = 0;

    for (const candidate of adjacent) {
        let tempSumEdges = 0;

        for (const other of adjacent) {
            if (candidate === other) continue;
            tempSumEdges += edgeWeightOf(ctx.globalGraph, candidate, other);
        }

        if (tempSumEdges < bestNeighborSum) {
            bestNeighborSum = tempSumEdges;
            interVertex = candidate;
        }
    }

    const spVertex = selectSteinerCandidate?.(ctx, adjacent);

    if (spVertex !== undefined) {
        for (const neighbor of adjacent) {
            steinerSum += edgeWeightOf(ctx.globalGraph, neighbor, spVertex);
        }
    }

    for (const neighbor of adjacent) {
        actionSum += edgeWeightOf(ctx.globalGraph, neighbor, ctx.actionVertexId);
    }

    let chosenIntersection = interVertex;

    if (
        spVertex !== undefined &&
        steinerSum < bestNeighborSum &&
        steinerSum < actionSum
    ) {
        chosenIntersection = spVertex;
    } else if (!(bestNeighborSum < actionSum && bestNeighborSum < steinerSum)) {
        const next = cloneGraph(ctx.groupGraph);
        makeSteiner(next, ctx.globalGraph, ctx.actionVertexId);
        return { graph: next, changed: true };
    }

    if (chosenIntersection === undefined) {
        throw new Error('rvTryReplaceNaive could not choose an intersection vertex.');
    }

    const next = cloneGraph(ctx.groupGraph);

    if (chosenIntersection === spVertex && !next.hasNode(spVertex)) {
        addSteinerVertexFromGlobal(next, ctx.globalGraph, spVertex);
    }

    next.dropNode(ctx.actionVertexId);
    insertEdgesFromIntersection(next, ctx.globalGraph, chosenIntersection, subtract(adjacent, chosenIntersection));

    return { graph: next, changed: true };
}

export function rvTRMDDLN(
    ctx: RemoveDynamicsContext,
    selectSteinerCandidate?: SelectSteinerCandidate,
): RemoveResult {
    const actionDegree = degreeOf(ctx.groupGraph, ctx.actionVertexId);

    if (actionDegree === 2) {
        return rvODTwoLocal(ctx);
    }

    if (actionDegree <= 1) {
        const next = cloneGraph(ctx.groupGraph);
        if (next.hasNode(ctx.actionVertexId)) {
            next.dropNode(ctx.actionVertexId);
        }
        return { graph: next, changed: true };
    }

    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));
    const adjacentSize = adjacent.size;

    let mcpDiameter = Number.POSITIVE_INFINITY;
    let spDiameter = Number.POSITIVE_INFINITY;
    let avDiameter = Number.POSITIVE_INFINITY;
    let mcpVertex: VertexId | undefined;

    for (const candidate of adjacent) {
        const projectedDegree =
            (degreeOf(ctx.groupGraph, candidate) - 1) + (adjacentSize - 1);

        if (projectedDegree < degreeLimitOf(ctx.globalGraph, candidate)) {
            const candidateGraph = simulateNeighborIntersection(
                ctx,
                candidate,
                adjacent,
            );
            const diameter = treeDiameter(candidateGraph);

            if (diameter < mcpDiameter) {
                mcpDiameter = diameter;
                mcpVertex = candidate;
            }
        }
    }

    const spVertex = selectSteinerCandidate?.(ctx, adjacent);

    if (
        spVertex !== undefined &&
        actionDegree <= degreeLimitOf(ctx.globalGraph, spVertex)
    ) {
        const spGraph = simulateSteinerIntersection(
            ctx,
            spVertex,
            adjacent,
        );
        spDiameter = treeDiameter(spGraph);
    }

    const avGraph = simulateKeepActionAsSteiner(ctx, adjacent);
    avDiameter = treeDiameter(avGraph);

    if (
        mcpVertex !== undefined &&
        mcpDiameter < spDiameter &&
        mcpDiameter < avDiameter
    ) {
        return {
            graph: simulateNeighborIntersection(ctx, mcpVertex, adjacent),
            changed: true,
        };
    }

    if (
        spVertex !== undefined &&
        spDiameter < avDiameter &&
        spDiameter < mcpDiameter
    ) {
        return {
            graph: simulateSteinerIntersection(ctx, spVertex, adjacent),
            changed: true,
        };
    }

    return {
        graph: avGraph,
        changed: true,
    };
}

function simulateNeighborIntersection(
    ctx: RemoveDynamicsContext,
    intersection: VertexId,
    adjacent: ReadonlySet<VertexId>,
): WeightedGraph {
    const next = cloneGraph(ctx.groupGraph);

    next.dropNode(ctx.actionVertexId);

    for (const neighbor of adjacent) {
        if (neighbor === intersection) continue;
        upsertWeightedEdge(next, ctx.globalGraph, intersection, neighbor);
    }

    return next;
}

function simulateSteinerIntersection(
    ctx: RemoveDynamicsContext,
    spVertex: VertexId,
    adjacent: ReadonlySet<VertexId>,
): WeightedGraph {
    const next = cloneGraph(ctx.groupGraph);

    next.dropNode(ctx.actionVertexId);
    addSteinerVertexFromGlobal(next, ctx.globalGraph, spVertex);

    for (const neighbor of adjacent) {
        upsertWeightedEdge(next, ctx.globalGraph, spVertex, neighbor);
    }

    return next;
}

function simulateKeepActionAsSteiner(
    ctx: RemoveDynamicsContext,
    adjacent: ReadonlySet<VertexId>,
): WeightedGraph {
    const next = cloneGraph(ctx.groupGraph);

    makeSteiner(next, ctx.globalGraph, ctx.actionVertexId);
    insertEdgesFromIntersection(next, ctx.globalGraph, ctx.actionVertexId, adjacent);

    return next;
}

function insertEdgesFromIntersection(
    graph: WeightedGraph,
    globalGraph: WeightedGraph,
    intersection: VertexId,
    targets: ReadonlySet<VertexId>,
): void {
    for (const target of targets) {
        if (target === intersection) continue;
        upsertWeightedEdge(graph, globalGraph, intersection, target);
    }
}

function upsertWeightedEdge(
    graph: WeightedGraph,
    globalGraph: WeightedGraph,
    a: VertexId,
    b: VertexId,
): void {
    if (graph.hasEdge(a, b)) return;

    graph.addEdge(a, b, {
        from: a,
        to: b,
        weight: edgeWeightOf(globalGraph, a, b),
    });
}

function addSteinerVertexFromGlobal(
    graph: WeightedGraph,
    globalGraph: WeightedGraph,
    vertexId: VertexId,
): void {
    if (graph.hasNode(vertexId)) return;

    const attrs = globalGraph.getNodeAttributes(vertexId);
    graph.addNode(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: globalGraph.getAttributes().degreeLimitSteiner,
    });
}

function makeSteiner(
    graph: WeightedGraph,
    globalGraph: WeightedGraph,
    vertexId: VertexId,
): void {
    if (!graph.hasNode(vertexId)) {
        addSteinerVertexFromGlobal(graph, globalGraph, vertexId);
        return;
    }

    const attrs = graph.getNodeAttributes(vertexId);
    graph.replaceNodeAttributes(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: globalGraph.getAttributes().degreeLimitSteiner,
    });
}

function subtract(
    input: ReadonlySet<VertexId>,
    value: VertexId,
): Set<VertexId> {
    const result = new Set(input);
    result.delete(value);
    return result;
}

function rvODTwoLocal(ctx: RemoveDynamicsContext): RemoveResult {
    const next = cloneGraph(ctx.groupGraph);
    const neighbors = neighborsOf(next, ctx.actionVertexId);

    if (neighbors.length !== 2) {
        throw new Error(
            `rvODTwo requires degree 2 for ${ctx.actionVertexId}, got ${neighbors.length}`,
        );
    }

    const [a, b] = neighbors;
    next.dropNode(ctx.actionVertexId);

    if (!next.hasEdge(a, b)) {
        next.addEdge(a, b, {
            from: a,
            to: b,
            weight: edgeWeightOf(ctx.globalGraph, a, b),
        });
    }

    return { graph: next, changed: true };
}

function treeDiameter(graph: WeightedGraph): number {
    const nodes = graph.nodes() as VertexId[];
    let diameter = 0;

    for (const source of nodes) {
        const distances = dijkstra(graph, source);
        for (const d of distances.values()) {
            if (Number.isFinite(d) && d > diameter) {
                diameter = d;
            }
        }
    }

    return diameter;
}

function dijkstra(
    graph: WeightedGraph,
    source: VertexId,
): Map<VertexId, number> {
    const nodes = graph.nodes() as VertexId[];
    const distances = new Map<VertexId, number>();
    const visited = new Set<VertexId>();

    for (const node of nodes) {
        distances.set(node, Number.POSITIVE_INFINITY);
    }
    distances.set(source, 0);

    while (visited.size < nodes.length) {
        let current: VertexId | undefined;
        let best = Number.POSITIVE_INFINITY;

        for (const node of nodes) {
            if (visited.has(node)) continue;
            const d = distances.get(node) ?? Number.POSITIVE_INFINITY;
            if (d < best) {
                best = d;
                current = node;
            }
        }

        if (current === undefined || !Number.isFinite(best)) {
            break;
        }

        visited.add(current);

        graph.forEachNeighbor(current, (neighbor: string) => {
            if (visited.has(neighbor)) return;

            const alt = best + edgeWeightOf(graph, current!, neighbor);
            const prev = distances.get(neighbor) ?? Number.POSITIVE_INFINITY;

            if (alt < prev) {
                distances.set(neighbor, alt);
            }
        });
    }

    return distances;
}
