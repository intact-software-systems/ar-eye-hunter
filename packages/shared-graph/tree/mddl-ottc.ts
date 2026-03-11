import { UndirectedGraph } from 'graphology';
import { EdgeProp, GraphProp, TreeGraph, VertexId, VertexProp } from '../graph-props.ts';

export type RelaxDegreeFn = (
    degreeBroken: ReadonlySet<VertexId>,
    degreeBound: Map<VertexId, number>,
) => boolean;

export function relaxDegreeByOne(
    degreeBroken: ReadonlySet<string>,
    degreeBound: Map<string, number>,
): boolean {
    if (degreeBroken.size === 0) {
        return false;
    }

    for (const v of degreeBroken) {
        degreeBound.set(v, (degreeBound.get(v) ?? 0) + 1);
    }

    return true;
}


export type MddlOttcComputed = {
    success: boolean;
    tree: TreeGraph;
};

type NearestChoice = {
    node?: VertexId;
    score: number;
};

type MddlState = {
    near: Map<VertexId, VertexId | undefined>;
    ecc: Map<VertexId, number>;
    degreeBound: Map<VertexId, number>;
    dist: Map<VertexId, Map<VertexId, number>>;
    notInTree: Set<VertexId>;
    nearest: NearestChoice;
};

export function mddlOTTC(
    inputGraph: TreeGraph,
    src: VertexId,
    treeNodes: ReadonlySet<VertexId>,
    relaxDegree: RelaxDegreeFn,
): MddlOttcComputed {
    const tree = createEmptyTreeLike(inputGraph);
    const state = initializeMddlState(inputGraph, src, treeNodes);

    if (state.nearest.node === undefined) {
        return { success: false, tree };
    }

    addVertexFromInput(tree, inputGraph, src);
    state.ecc.set(src, 0);
    setDist(state.dist, src, src, 0);
    state.notInTree.delete(src);

    while (state.notInTree.size > 0) {
        const next = state.nearest.node;
        if (next === undefined) {
            return { success: false, tree };
        }

        const parent = state.near.get(next);
        if (parent === undefined || !tree.hasNode(parent)) {
            return { success: false, tree };
        }

        attachVertex(tree, inputGraph, next, parent, state);
        state.notInTree.delete(next);

        if (state.notInTree.size === 0) {
            break;
        }

        recomputeNearForNotInTree(tree, inputGraph, state);
        state.nearest = selectNextNearestVertex(tree, inputGraph, state, relaxDegree);

        if (state.nearest.node === undefined) {
            return { success: false, tree };
        }
    }

    return { success: state.notInTree.size === 0, tree };
}

function initializeMddlState(
    inputGraph: TreeGraph,
    src: VertexId,
    treeNodes: ReadonlySet<VertexId>,
): MddlState {
    const near = new Map<VertexId, VertexId | undefined>();
    const ecc = new Map<VertexId, number>();
    const degreeBound = new Map<VertexId, number>();
    const dist = new Map<VertexId, Map<VertexId, number>>();
    const notInTree = new Set<VertexId>(treeNodes);
    let nearest: NearestChoice = {
        node: undefined,
        score: Number.POSITIVE_INFINITY,
    };

    for (const v of treeNodes) {
        degreeBound.set(v, getDegreeConstraint(inputGraph, v));
        ecc.set(v, 0);

        if (v === src) {
            near.set(v, src);
        } else {
            const edgeKey = inputGraph.edge(v, src);
            if (edgeKey !== undefined) {
                near.set(v, src);
                const w = inputGraph.getEdgeAttribute(edgeKey, 'weight') as number;
                if (w < nearest.score) {
                    nearest = { node: v, score: w };
                }
            } else {
                near.set(v, undefined);
            }
        }

        const row = new Map<VertexId, number>();
        for (const u of treeNodes) {
            row.set(u, 0);
        }
        dist.set(v, row);
    }

    return {
        near,
        ecc,
        degreeBound,
        dist,
        notInTree,
        nearest,
    };
}

function attachVertex(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    node: VertexId,
    parent: VertexId,
    state: MddlState,
): void {
    addVertexFromInput(tree, inputGraph, node);
    addEdgeFromInput(tree, inputGraph, node, parent);

    const bound = state.degreeBound.get(parent) ?? 0;
    if (tree.degree(parent) > bound) {
        throw new Error(`Degree bound exceeded for ${parent}`);
    }

    updateDistanceStateAfterAttach(tree, inputGraph, state, node, parent);
}

function updateDistanceStateAfterAttach(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    state: MddlState,
    node: VertexId,
    parent: VertexId,
): void {
    const edgeKey = inputGraph.edge(node, parent);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge (${node}, ${parent})`);
    }

    const weight = inputGraph.getEdgeAttribute(edgeKey, 'weight') as number;

    for (const u of tree.nodes() as VertexId[]) {
        const parentToU = getDist(state.dist, parent, u);
        if (parentToU > 0) {
            setDist(state.dist, node, u, parentToU + weight);
        }
    }

    setDist(state.dist, node, node, 0);
    state.ecc.set(node, (state.ecc.get(parent) ?? 0) + weight);

    setDist(state.dist, parent, node, weight);
    if ((state.ecc.get(parent) ?? 0) <= 0) {
        state.ecc.set(parent, weight);
    }

    for (const u of tree.nodes() as VertexId[]) {
        const uToParent = getDist(state.dist, u, parent);
        setDist(state.dist, u, node, uToParent + weight);
        state.ecc.set(u, Math.max(state.ecc.get(u) ?? 0, getDist(state.dist, u, node)));
    }
}

function recomputeNearForNotInTree(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    state: MddlState,
): void {
    for (const v of state.notInTree) {
        let bestParent: VertexId | undefined;
        let bestScore = Number.POSITIVE_INFINITY;

        for (const inTree of tree.nodes() as VertexId[]) {
            const edgeKey = inputGraph.edge(v, inTree);
            if (edgeKey === undefined) continue;
            if (tree.degree(inTree) >= (state.degreeBound.get(inTree) ?? 0)) continue;

            const weight = inputGraph.getEdgeAttribute(edgeKey, 'weight') as number;
            const score = (state.ecc.get(inTree) ?? 0) + weight;

            if (score < bestScore) {
                bestParent = inTree;
                bestScore = score;
            }
        }

        state.near.set(v, bestParent);
    }
}

function selectNextNearestVertex(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    state: MddlState,
    relaxDegree: RelaxDegreeFn,
): NearestChoice {
    let failsafe = 0;

    while (true) {
        let nearest: NearestChoice = {
            node: undefined,
            score: Number.POSITIVE_INFINITY,
        };

        const degreeBroken = new Set<VertexId>();

        for (const v of state.notInTree) {
            const nearV = state.near.get(v);
            if (nearV === undefined) continue;

            const edgeKey = inputGraph.edge(v, nearV);
            if (edgeKey === undefined) continue;

            const bound = state.degreeBound.get(nearV) ?? 0;
            const outDegree = tree.degree(nearV);
            const weight = inputGraph.getEdgeAttribute(edgeKey, 'weight') as number;
            const score = (state.ecc.get(nearV) ?? 0) + weight;

            if (outDegree < bound && score < nearest.score) {
                nearest = { node: v, score };
            }

            if (outDegree >= bound) {
                degreeBroken.add(nearV);
            }
        }

        if (nearest.node !== undefined) {
            return nearest;
        }

        if (degreeBroken.size === 0) {
            return nearest;
        }

        if (!relaxDegree(degreeBroken, state.degreeBound)) {
            return nearest;
        }

        failsafe++;
        if (failsafe >= Number.MAX_SAFE_INTEGER - 1) {
            return nearest;
        }
    }
}

export function createEmptyTreeLike(inputGraph: TreeGraph): TreeGraph {
    const tree = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    tree.replaceAttributes(inputGraph.getAttributes());
    return tree;
}

function getDegreeConstraint(graph: TreeGraph, node: VertexId): number {
    return graph.getNodeAttributes(node).degreeLimit;
}

function addVertexFromInput(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    node: VertexId,
): void {
    if (tree.hasNode(node)) return;
    tree.addNode(node, { ...inputGraph.getNodeAttributes(node) });
}

function addEdgeFromInput(
    tree: TreeGraph,
    inputGraph: TreeGraph,
    a: VertexId,
    b: VertexId,
): void {
    if (tree.hasEdge(a, b)) return;

    const edgeKey = inputGraph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge (${a}, ${b}) in input graph`);
    }

    const weight = inputGraph.getEdgeAttribute(edgeKey, 'weight') as number;
    tree.addEdge(a, b, {
        from: a,
        to: b,
        weight,
    });
}

function getDist(
    dist: Map<VertexId, Map<VertexId, number>>,
    a: VertexId,
    b: VertexId,
): number {
    return dist.get(a)?.get(b) ?? 0;
}

function setDist(
    dist: Map<VertexId, Map<VertexId, number>>,
    a: VertexId,
    b: VertexId,
    value: number,
): void {
    let row = dist.get(a);
    if (row === undefined) {
        row = new Map<VertexId, number>();
        dist.set(a, row);
    }
    row.set(b, value);
}