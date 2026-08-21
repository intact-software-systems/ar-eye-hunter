import { SelectSteinerCandidate } from '../algo-props.ts';
import { TreeGraph, VertexId, VertexState, VertexType } from '../graph-props.ts';
import { cloneTree, dijkstraOnTreeFromSource } from '../graph/graph-algs.ts';

/**
 * Port of REMOVE_TRY_REPLACE_MDDL_NAIVE (rvTRMDDLN).
 */
export function removeTryReplaceMDDL(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    selectSteinerCandidate?: SelectSteinerCandidate
): TreeGraph {
    const actionDegree = tree.degree(actionVertexId);

    if (actionDegree <= 1) {
        return removeLeaf(tree, actionVertexId);
    }

    if (actionDegree === 2) {
        return removeOutDegreeTwo(tree, globalGraph, actionVertexId);
    }

    const adjacent = new Set(tree.neighbors(actionVertexId) as VertexId[]);
    const adjacentSize = adjacent.size;

    let mcpDiameter = Number.POSITIVE_INFINITY;
    let spDiameter = Number.POSITIVE_INFINITY;
    let avDiameter = Number.POSITIVE_INFINITY;

    let mcpVertexId: VertexId | undefined;

    // 1) Try using one existing neighbor as intersection
    for (const candidate of adjacent) {
        const projectedDegree = (tree.degree(candidate) - 1) + (adjacentSize - 1);

        if (projectedDegree < getDegreeLimit(globalGraph, candidate)) {
            const candidateTree = simulateNeighborIntersection(
                tree,
                globalGraph,
                actionVertexId,
                candidate,
                adjacent
            );

            const candidateDiameter = treeDiameter(candidateTree);
            if (candidateDiameter < mcpDiameter) {
                mcpDiameter = candidateDiameter;
                mcpVertexId = candidate;
            }
        }
    }

    // 2) Try using a Steiner/core vertex as intersection
    let spVertexId: VertexId | undefined;
    if (selectSteinerCandidate !== undefined) {
        spVertexId = selectSteinerCandidate(tree, globalGraph, actionVertexId, adjacent);
    }

    if (
        spVertexId !== undefined &&
        actionDegree <= getDegreeLimit(globalGraph, spVertexId)
    ) {
        const spTree = simulateSteinerIntersection(
            tree,
            globalGraph,
            actionVertexId,
            spVertexId,
            adjacent
        );
        spDiameter = treeDiameter(spTree);
    }

    // 3) Keep the action vertex as Steiner/core intersection
    const avTree = simulateKeepActionAsSteiner(tree, globalGraph, actionVertexId);
    avDiameter = treeDiameter(avTree);

    // Same tie behavior as the C++:
    // if MCP is strictly best -> use it
    // else if SP is strictly best -> use it
    // else -> keep action as Steiner
    if (
        mcpVertexId !== undefined &&
        mcpDiameter < spDiameter &&
        mcpDiameter < avDiameter
    ) {
        return simulateNeighborIntersection(
            tree,
            globalGraph,
            actionVertexId,
            mcpVertexId,
            adjacent
        );
    }

    if (
        spVertexId !== undefined &&
        spDiameter < avDiameter &&
        spDiameter < mcpDiameter
    ) {
        return simulateSteinerIntersection(
            tree,
            globalGraph,
            actionVertexId,
            spVertexId,
            adjacent
        );
    }

    return avTree;
}

function simulateNeighborIntersection(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    mcpVertexId: VertexId,
    adjacent: ReadonlySet<VertexId>
): TreeGraph {
    const next = cloneTree(tree);

    // remove the action member entirely
    next.dropNode(actionVertexId);

    for (const neighbor of adjacent) {
        if (neighbor === mcpVertexId) {
            continue;
        }
        upsertWeightedEdge(next, globalGraph, mcpVertexId, neighbor);
    }

    return next;
}

function simulateSteinerIntersection(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    spVertexId: VertexId,
    adjacent: ReadonlySet<VertexId>
): TreeGraph {
    const next = cloneTree(tree);

    next.dropNode(actionVertexId);
    addSteinerVertexFromGlobal(next, globalGraph, spVertexId);

    for (const neighbor of adjacent) {
        upsertWeightedEdge(next, globalGraph, spVertexId, neighbor);
    }

    return next;
}

function simulateKeepActionAsSteiner(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId
): TreeGraph {
    const next = cloneTree(tree);

    const attrs = next.getNodeAttributes(actionVertexId);
    next.replaceNodeAttributes(actionVertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: globalGraph.getAttributes().degreeLimitSteiner
    });

    return next;
}

function removeLeaf(
    tree: TreeGraph,
    actionVertexId: VertexId
): TreeGraph {
    const next = cloneTree(tree);
    next.dropNode(actionVertexId);
    return next;
}

function removeOutDegreeTwo(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId
): TreeGraph {
    const next = cloneTree(tree);
    const neighbors = next.neighbors(actionVertexId) as VertexId[];

    if (neighbors.length !== 2) {
        throw new Error(
            `removeOutDegreeTwo expected degree 2 for ${actionVertexId}, got ${neighbors.length}`
        );
    }

    const [a, b] = neighbors;
    next.dropNode(actionVertexId);
    upsertWeightedEdge(next, globalGraph, a, b);

    return next;
}

function addSteinerVertexFromGlobal(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    vertexId: VertexId
): void {
    if (tree.hasNode(vertexId)) {
        return;
    }

    const attrs = globalGraph.getNodeAttributes(vertexId);
    tree.addNode(vertexId, {
        ...attrs,
        type: VertexType.CORE,
        state: VertexState.STEINER,
        degreeLimit: globalGraph.getAttributes().degreeLimitSteiner
    });
}

function upsertWeightedEdge(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    a: VertexId,
    b: VertexId
): void {
    if (tree.hasEdge(a, b)) {
        return;
    }

    const weight = getEdgeWeight(globalGraph, a, b);
    tree.addEdge(a, b, {
        from: a,
        to: b,
        weight
    });
}

function getDegreeLimit(
    graph: TreeGraph,
    node: VertexId
): number {
    return graph.getNodeAttributes(node).degreeLimit;
}

function getEdgeWeight(
    graph: TreeGraph,
    a: VertexId,
    b: VertexId
): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing edge between ${a} and ${b}`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

function treeDiameter(tree: TreeGraph): number {
    const nodes = tree.nodes() as VertexId[];
    let diameter = 0;

    for (const source of nodes) {
        const distances = dijkstraOnTreeFromSource(tree, source);
        for (const d of distances.values()) {
            if (Number.isFinite(d) && d > diameter) {
                diameter = d;
            }
        }
    }

    return diameter;
}
