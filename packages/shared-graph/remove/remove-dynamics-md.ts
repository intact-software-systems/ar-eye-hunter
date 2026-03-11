import { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';
import { degreeLimitOf, degreeOf, neighborsOf, } from './remove-dynamics-helpers.ts';
import { connectMDE, connectSearchMDE, } from './tree-dynamics-connect.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function rvMDEdge(ctx: RemoveDynamicsContext): RemoveResult {
    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));

    const odAvailableNeighbors =
        getAvailableOutDegree(ctx.groupGraph, ctx.globalGraph, adjacent) +
        adjacent.size;

    const minOdNeeded = getMinODNeedConnectV(adjacent.size);

    if (odAvailableNeighbors < minOdNeeded) {
        throw new Error('rvMDEdge infeasible: insufficient available out-degree.');
    }

    const next = cloneGraph(ctx.groupGraph);
    next.dropNode(ctx.actionVertexId);

    const result = connectMDE(
        {
            globalGraph: ctx.globalGraph,
            groupGraph: next,
        },
        new Set(adjacent),
        new Set<VertexId>(),
    );

    return {
        graph: result.graph,
        changed: true,
    };
}

export function rvSearchMDEdge(ctx: RemoveDynamicsContext): RemoveResult {
    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));

    const odAvailableNeighbors =
        getAvailableOutDegree(ctx.groupGraph, ctx.globalGraph, adjacent) +
        adjacent.size;

    const minOdNeeded = getMinODNeedConnectV(adjacent.size);

    if (odAvailableNeighbors < minOdNeeded) {
        throw new Error('rvSearchMDEdge infeasible: insufficient available out-degree.');
    }

    const next = cloneGraph(ctx.groupGraph);
    next.dropNode(ctx.actionVertexId);

    const result = connectSearchMDE(
        {
            globalGraph: ctx.globalGraph,
            groupGraph: next,
        },
        new Set(adjacent),
        new Set<VertexId>(),
    );

    return {
        graph: result.graph,
        changed: true,
    };
}

function getAvailableOutDegree(
    graph: TreeGraph,
    globalGraph: TreeGraph,
    vertices: ReadonlySet<VertexId>,
): number {
    let total = 0;

    for (const v of vertices) {
        total += Math.max(0, degreeLimitOf(globalGraph, v) - degreeOf(graph, v));
    }

    return total;
}

function getMinODNeedConnectV(vertexCount: number): number {
    return ((vertexCount - 1) * 2);
}