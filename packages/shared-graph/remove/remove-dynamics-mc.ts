import { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';
import { degreeLimitOf, degreeOf, neighborsOf, } from './remove-dynamics-helpers.ts';
import { connectMCE, connectSearchMCE, } from './tree-dynamics-connect.ts';
import { TreeGraph, VertexId } from '../graph-props.ts';
import { cloneGraph } from '../graph/graph-algs.ts';

export function rvMCEdge(ctx: RemoveDynamicsContext): RemoveResult {
    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));

    const odAvailableNeighbors =
        getAvailableOutDegree(ctx.groupGraph, ctx.globalGraph, adjacent) +
        adjacent.size;

    const minOdNeeded = getMinODNeedConnectV(adjacent.size);

    if (odAvailableNeighbors < minOdNeeded) {
        throw new Error('rvMCEdge infeasible: insufficient available out-degree.');
    }

    const next = cloneGraph(ctx.groupGraph);
    const connected = seedConnectedVertex(next, adjacent);
    next.dropNode(ctx.actionVertexId);

    const remaining = subtract(adjacent, connected);

    const result = connectMCE(
        {
            globalGraph: ctx.globalGraph,
            groupGraph: next,
        },
        remaining,
        new Set([connected]),
    );

    return {
        graph: result.graph,
        changed: true,
    };
}

export function rvSearchMCEdge(ctx: RemoveDynamicsContext): RemoveResult {
    const adjacent = new Set(neighborsOf(ctx.groupGraph, ctx.actionVertexId));

    const odAvailableNeighbors =
        getAvailableOutDegree(ctx.groupGraph, ctx.globalGraph, adjacent) +
        adjacent.size;

    const minOdNeeded = getMinODNeedConnectV(adjacent.size);

    if (odAvailableNeighbors < minOdNeeded) {
        throw new Error('rvSearchMCEdge infeasible: insufficient available out-degree.');
    }

    const next = cloneGraph(ctx.groupGraph);
    const connected = seedConnectedVertex(next, adjacent);
    next.dropNode(ctx.actionVertexId);

    const remaining = subtract(adjacent, connected);

    const result = connectSearchMCE(
        {
            globalGraph: ctx.globalGraph,
            groupGraph: next,
        },
        remaining,
        new Set([connected]),
    );

    return {
        graph: result.graph,
        changed: true,
    };
}

function seedConnectedVertex(
    graph: TreeGraph,
    adjacent: ReadonlySet<VertexId>,
): VertexId {
    const ordered = [...adjacent].sort((a, b) => {
        const da = degreeOf(graph, a);
        const db = degreeOf(graph, b);
        if (da !== db) {
            return db - da;
        }
        return a.localeCompare(b);
    });

    const first = ordered[0];
    if (first === undefined) {
        throw new Error('Cannot seed connected vertex from empty adjacent set.');
    }

    return first;
}

function subtract(
    input: ReadonlySet<VertexId>,
    value: VertexId,
): Set<VertexId> {
    const result = new Set(input);
    result.delete(value);
    return result;
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

/**
 * A practical TS equivalent of the C++ feasibility helper.
 *
 * To connect n neighbor vertices into one connected structure,
 * you need at least n - 2 additional endpoint capacities in the
 * simplest tree-like reconnection case.
 *
 * The old code uses getMinODNeedConnectV(adjacent.size()).
 * This function is the cleanest TS interpretation.
 */
function getMinODNeedConnectV(vertexCount: number): number {
    return ((vertexCount - 1) * 2);
}