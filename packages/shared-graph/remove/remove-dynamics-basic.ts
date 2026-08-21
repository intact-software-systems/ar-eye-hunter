import { cloneGraph } from '../graph/graph-algs.ts';
import { degreeOf, edgeWeightOf, neighborsOf, withUnusedSteinerRemoved } from './remove-dynamics-helpers.ts';
import { RemoveDynamicsContext, RemoveResult } from './remove-dynamics-types.ts';

export function rvLeaf(ctx: RemoveDynamicsContext): RemoveResult {
    const next = cloneGraph(ctx.groupGraph);

    if (!next.hasNode(ctx.actionVertexId)) {
        return { graph: next, changed: false };
    }

    next.dropNode(ctx.actionVertexId);
    return { graph: next, changed: true };
}

export function rvODTwo(ctx: RemoveDynamicsContext): RemoveResult {
    const next = cloneGraph(ctx.groupGraph);

    if (!next.hasNode(ctx.actionVertexId)) {
        return { graph: next, changed: false };
    }

    const neighbors = neighborsOf(next, ctx.actionVertexId);
    if (neighbors.length !== 2) {
        throw new Error(
            `rvODTwo requires degree 2 for ${ctx.actionVertexId}, got ${neighbors.length}`
        );
    }

    const [a, b] = neighbors;

    next.dropNode(ctx.actionVertexId);

    if (!next.hasEdge(a, b)) {
        next.addEdge(a, b, {
            from: a,
            to: b,
            weight: edgeWeightOf(ctx.globalGraph, a, b)
        });
    }

    return { graph: next, changed: true };
}

export function rvUnusedSP(ctx: RemoveDynamicsContext): RemoveResult {
    const next = withUnusedSteinerRemoved(ctx.groupGraph);
    return { graph: next, changed: true };
}

export function removeBasic(ctx: RemoveDynamicsContext): RemoveResult {
    const degree = degreeOf(ctx.groupGraph, ctx.actionVertexId);

    if (degree <= 0) {
        return { graph: cloneGraph(ctx.groupGraph), changed: false };
    }

    if (degree === 1) {
        return rvLeaf(ctx);
    }

    if (degree === 2) {
        return rvODTwo(ctx);
    }

    return { graph: cloneGraph(ctx.groupGraph), changed: false };
}
