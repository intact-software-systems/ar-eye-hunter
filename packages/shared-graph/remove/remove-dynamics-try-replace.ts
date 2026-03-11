import { TreeGraph, VertexId, VertexState, VertexType } from '../graph-props.ts';
import type { RemoveDynamicsContext, RemoveResult, } from './remove-dynamics-types.ts';
import { degreeLimitOf, degreeOf, edgeWeightOf, neighborsOf, } from './remove-dynamics-helpers.ts';
import { connectMCE, connectMDE, connectSearchMCE, connectSearchMDE, } from './tree-dynamics-connect.ts';
import { getNeighborsOptimizeSP } from './remove-dynamics-optimize-neighbors.ts';
import { CoreSelectionAlgo, findWCNodes } from '../graph/steiner-core-algorithms.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function rvTryReplace(
    ctx: RemoveDynamicsContext,
    coreSelectionAlgo: CoreSelectionAlgo = CoreSelectionAlgo.CENTER_SELECTION,
): RemoveResult {
    const actionDegree = degreeOf(ctx.groupGraph, ctx.actionVertexId);

    if (actionDegree > 2) {
        return rvTryReplaceHighDegree(ctx, coreSelectionAlgo);
    }

    if (actionDegree === 2) {
        return rvODTwoLocal(ctx);
    }

    if (actionDegree === 1) {
        return rvLeafLocal(ctx);
    }

    return {
        graph: cloneGraph(ctx.groupGraph),
        changed: false,
    };
}

function rvTryReplaceHighDegree(
    ctx: RemoveDynamicsContext,
    coreSelectionAlgo: CoreSelectionAlgo,
): RemoveResult {
    const next = cloneGraph(ctx.groupGraph);

    const {
        adjacentMembers,
        adjacentSteiner,
        removableEdgeKeys,
    } = getNeighborsOptimizeSP(next, ctx.actionVertexId);

    adjacentMembers.delete(ctx.actionVertexId);

    for (const edgeKey of removableEdgeKeys) {
        if (next.hasEdge(edgeKey)) {
            next.dropEdge(edgeKey);
        }
    }

    const steinerDegreeLimit = next.getAttributes().degreeLimitSteiner;
    const numNewSP =
        Math.ceil(adjacentMembers.size / Math.max(1, steinerDegreeLimit)) -
        adjacentSteiner.size;

    let newSPSet = new Set<VertexId>();

    if (numNewSP > 0) {
        const chosen = findWCNodes(
            ctx.globalGraph,
            ctx.steinerCandidates,
            union(adjacentMembers, new Set([ctx.actionVertexId])),
            nextNodeSet(next),
            numNewSP,
            coreSelectionAlgo,
        );

        newSPSet = new Set(chosen);
    }

    const testVertices = union(adjacentMembers, union(adjacentSteiner, newSPSet));

    const ranked = rankIntersectionVertices(
        ctx.globalGraph,
        adjacentMembers,
        testVertices,
        next,
    );

    const connectV = selectIntersectionVertices(
        ranked,
        ctx.globalGraph,
        next,
        adjacentMembers.size,
    );

    const removeSteiner = difference(adjacentSteiner, connectV);
    for (const v of removeSteiner) {
        if (next.hasNode(v)) {
            const attrs = next.getNodeAttributes(v);
            if (attrs.state === VertexState.STEINER) {
                next.dropNode(v);
            }
        }
    }

    if (next.hasNode(ctx.actionVertexId)) {
        next.dropNode(ctx.actionVertexId);
    }

    newSPSet = difference(newSPSet, removeSteiner);

    for (const sp of newSPSet) {
        addSteinerVertexFromGlobal(next, ctx.globalGraph, sp);
    }

    const totalToConnect = union(connectV, adjacentMembers);

    switch (ctx.treeAlgo) {
        case 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MDDL': {
            const result = connectSearchMDE(
                {
                    globalGraph: ctx.globalGraph,
                    groupGraph: next,
                },
                new Set(totalToConnect),
                new Set<VertexId>(),
            );
            return pruneLeafSteinerConnectors(result.graph, connectV);
        }

        case 'REMOVE_TRY_REPLACE_PRUNE_MDDL': {
            const result = connectMDE(
                {
                    globalGraph: ctx.globalGraph,
                    groupGraph: next,
                },
                new Set(totalToConnect),
                new Set<VertexId>(),
            );
            return pruneLeafSteinerConnectors(result.graph, connectV);
        }

        case 'REMOVE_TRY_REPLACE_PRUNE_SEARCH_MC': {
            const seeded = seedHighestDegreeVertex(next, totalToConnect);
            const remaining = difference(totalToConnect, new Set([seeded]));
            const result = connectSearchMCE(
                {
                    globalGraph: ctx.globalGraph,
                    groupGraph: next,
                },
                remaining,
                new Set<VertexId>([seeded]),
            );
            return pruneLeafSteinerConnectors(result.graph, connectV);
        }

        case 'REMOVE_TRY_REPLACE_PRUNE_MC':
        default: {
            const seeded = seedHighestDegreeVertex(next, totalToConnect);
            const remaining = difference(totalToConnect, new Set([seeded]));
            const result = connectMCE(
                {
                    globalGraph: ctx.globalGraph,
                    groupGraph: next,
                },
                remaining,
                new Set<VertexId>([seeded]),
            );
            return pruneLeafSteinerConnectors(result.graph, connectV);
        }
    }
}

function rankIntersectionVertices(
    globalGraph: TreeGraph,
    adjacentMembers: ReadonlySet<VertexId>,
    testVertices: ReadonlySet<VertexId>,
    currentGraph: TreeGraph,
): Array<{ node: VertexId; sumEdges: number }> {
    const ranked: Array<{ node: VertexId; sumEdges: number }> = [];

    for (const candidate of testVertices) {
        let sumEdges = 0;

        for (const member of adjacentMembers) {
            if (candidate === member) continue;
            if (!globalGraph.hasEdge(candidate, member)) continue;

            sumEdges += edgeWeightOf(globalGraph, candidate, member);
        }

        ranked.push({ node: candidate, sumEdges });
    }

    ranked.sort((a, b) => a.sumEdges - b.sumEdges || a.node.localeCompare(b.node));
    return ranked;
}

function selectIntersectionVertices(
    ranked: ReadonlyArray<{ node: VertexId; sumEdges: number }>,
    globalGraph: TreeGraph,
    currentGraph: TreeGraph,
    adjacentMemberCount: number,
): Set<VertexId> {
    const connectV = new Set<VertexId>();
    let sumODCapacity = 0;

    for (const entry of ranked) {
        const node = entry.node;
        const odCapacity =
            degreeLimitOf(globalGraph, node) -
            (currentGraph.hasNode(node) ? degreeOf(currentGraph, node) : 0);

        if (odCapacity > 1) {
            connectV.add(node);
            sumODCapacity += odCapacity;
        }

        const connectInterconnectOD =
            connectV.size <= 1 ? 0 : ((connectV.size - 2) * 2) + 2;

        if (sumODCapacity >= adjacentMemberCount + connectInterconnectOD) {
            break;
        }
    }

    return connectV;
}

function pruneLeafSteinerConnectors(
    graph: TreeGraph,
    connectV: ReadonlySet<VertexId>,
): RemoveResult {
    const next = cloneGraph(graph);

    for (const v of connectV) {
        if (!next.hasNode(v)) continue;

        const attrs = next.getNodeAttributes(v);
        if (attrs.state !== VertexState.MEMBER && next.degree(v) <= 1) {
            next.dropNode(v);
        }
    }

    return {
        graph: next,
        changed: true,
    };
}

function addSteinerVertexFromGlobal(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    vertexId: VertexId,
): void {
    if (graph.hasNode(vertexId)) return;

    const attrs = globalGraph.getNodeAttributes(vertexId);
    graph.addNode(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: graph.getAttributes().degreeLimitSteiner,
    });
}

function seedHighestDegreeVertex(
    graph: TreeGraph,
    vertices: ReadonlySet<VertexId>,
): VertexId {
    const sorted = [...vertices].sort((a, b) => {
        const da = graph.hasNode(a) ? graph.degree(a) : 0;
        const db = graph.hasNode(b) ? graph.degree(b) : 0;

        if (da !== db) {
            return db - da;
        }

        return a.localeCompare(b);
    });

    const first = sorted[0];
    if (first === undefined) {
        throw new Error('Cannot seed highest-degree vertex from empty set.');
    }

    return first;
}

function union<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
    const out = new Set<T>(a);
    for (const x of b) out.add(x);
    return out;
}

function difference<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> {
    const out = new Set<T>();
    for (const x of a) {
        if (!b.has(x)) out.add(x);
    }
    return out;
}

function nextNodeSet(graph: TreeGraph): Set<VertexId> {
    return new Set(graph.nodes() as VertexId[]);
}

function rvLeafLocal(ctx: RemoveDynamicsContext): RemoveResult {
    const next = cloneGraph(ctx.groupGraph);
    if (next.hasNode(ctx.actionVertexId)) {
        next.dropNode(ctx.actionVertexId);
    }

    return {
        graph: next,
        changed: true,
    };
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

    return {
        graph: next,
        changed: true,
    };
}
