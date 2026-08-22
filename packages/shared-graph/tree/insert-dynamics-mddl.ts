import { SelectSteinerCandidate } from '../algo-props.ts';
import { TreeGraph, VertexId, VertexState, VertexType } from '../graph-props.ts';
import {
    canAcceptChild,
    cloneTree,
    diameterDistance,
    disconnectAllEdges,
    eccentricity,
    getEdgeWeight,
    neighborsOf
} from '../graph/graph-algs.ts';

export function insertMinimumDiameterDegreeLimitedEdge(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    selectSteinerCandidate?: SelectSteinerCandidate
): TreeGraph {
    let bestScore = Number.POSITIVE_INFINITY;
    let bestTarget: VertexId | undefined;

    for (const candidate of tree.nodes() as string[]) {
        if (!canAcceptChild(tree, candidate)) {
            continue;
        }
        if (candidate === actionVertexId) {
            continue;
        }

        const connectWeight = getEdgeWeight(globalGraph, actionVertexId, candidate);
        const worstCaseDistance = tree.degree(candidate) > 0
            ? eccentricity(tree, candidate)
            : 0;

        const score = connectWeight + worstCaseDistance;

        if (score < bestScore) {
            bestScore = score;
            bestTarget = candidate;
        }
    }

    if (bestTarget !== undefined) {
        const next = cloneTree(tree);
        addMemberVertexFromGlobal(next, globalGraph, actionVertexId);
        upsertWeightedEdge(next, globalGraph, actionVertexId, bestTarget);
        return next;
    }

    return insertTryReplaceMddlNaive(
        tree,
        globalGraph,
        actionVertexId,
        selectSteinerCandidate
    );
}

export function insertTryReplaceMddlNaive(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    selectSteinerCandidate?: SelectSteinerCandidate
): TreeGraph {
    let bestScore = Number.POSITIVE_INFINITY;
    let mcpVertexId: VertexId | undefined;

    for (const candidate of tree.nodes() as string[]) {
        if (!canAcceptChild(tree, candidate)) {
            continue;
        }

        const connectWeight = getEdgeWeight(globalGraph, actionVertexId, candidate);
        const worstCaseDistance = tree.degree(candidate) > 0
            ? eccentricity(tree, candidate)
            : 0;

        const score = connectWeight + worstCaseDistance;

        if (score < bestScore) {
            bestScore = score;
            mcpVertexId = candidate;
        }
    }

    if (mcpVertexId === undefined) {
        throw new Error('insertTryReplaceMddlNaive failed: no degree-feasible target found.');
    }

    const adjacent = neighborsOf(tree, mcpVertexId);
    const directTree = simulateDirectAttach(tree, globalGraph, actionVertexId, mcpVertexId);
    const directDiameter = diameterDistance(directTree);

    let steinerTree: TreeGraph | undefined;
    let steinerDiameter = Number.POSITIVE_INFINITY;

    const spVertexId = selectSteinerCandidate?.(
        tree,
        globalGraph,
        actionVertexId,
        new Set([mcpVertexId])
    );

    if (
        spVertexId !== undefined &&
        tree.degree(mcpVertexId) <= globalGraph.getNodeAttributes(spVertexId).degreeLimit
    ) {
        steinerTree = simulateSteinerIntersection(
            tree,
            globalGraph,
            actionVertexId,
            mcpVertexId,
            spVertexId,
            adjacent
        );
        steinerDiameter = diameterDistance(steinerTree);
    }

    let actionTree: TreeGraph | undefined;
    let actionDiameter = Number.POSITIVE_INFINITY;

    if (tree.degree(mcpVertexId) <= globalGraph.getNodeAttributes(actionVertexId).degreeLimit) {
        actionTree = simulateActionVertexIntersection(
            tree,
            globalGraph,
            actionVertexId,
            mcpVertexId,
            adjacent
        );
        actionDiameter = diameterDistance(actionTree);
    }

    if (actionTree !== undefined && actionDiameter < steinerDiameter && actionDiameter < directDiameter) {
        return actionTree;
    }

    if (steinerTree !== undefined && steinerDiameter < actionDiameter && steinerDiameter < directDiameter) {
        return steinerTree;
    }

    return directTree;
}

function simulateDirectAttach(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    mcpVertexId: VertexId
): TreeGraph {
    const next = cloneTree(tree);
    addMemberVertexFromGlobal(next, globalGraph, actionVertexId);
    upsertWeightedEdge(next, globalGraph, actionVertexId, mcpVertexId);
    return next;
}

function simulateSteinerIntersection(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    mcpVertexId: VertexId,
    spVertexId: VertexId,
    adjacent: VertexId[]
): TreeGraph {
    const next = cloneTree(tree);

    addSteinerVertexFromGlobal(next, globalGraph, spVertexId);

    disconnectAllEdges(next, mcpVertexId);

    for (const neighbor of adjacent) {
        upsertWeightedEdge(next, globalGraph, spVertexId, neighbor);
    }

    const mcpAttrs = next.getNodeAttributes(mcpVertexId);
    const mcpIsSteiner = mcpAttrs.state === VertexState.STEINER;

    if (!mcpIsSteiner) {
        upsertWeightedEdge(next, globalGraph, spVertexId, mcpVertexId);
    }
    else if (next.degree(mcpVertexId) === 0) {
        next.dropNode(mcpVertexId);
    }

    addMemberVertexFromGlobal(next, globalGraph, actionVertexId);
    upsertWeightedEdge(next, globalGraph, spVertexId, actionVertexId);

    return next;
}

function simulateActionVertexIntersection(
    tree: TreeGraph,
    globalGraph: TreeGraph,
    actionVertexId: VertexId,
    mcpVertexId: VertexId,
    adjacent: VertexId[]
): TreeGraph {
    const next = cloneTree(tree);

    addMemberVertexFromGlobal(next, globalGraph, actionVertexId);
    disconnectAllEdges(next, mcpVertexId);

    for (const neighbor of adjacent) {
        upsertWeightedEdge(next, globalGraph, actionVertexId, neighbor);
    }

    const mcpAttrs = next.getNodeAttributes(mcpVertexId);
    const mcpIsSteiner = mcpAttrs.state === VertexState.STEINER;

    if (!mcpIsSteiner) {
        upsertWeightedEdge(next, globalGraph, actionVertexId, mcpVertexId);
    }
    else if (next.degree(mcpVertexId) === 0) {
        next.dropNode(mcpVertexId);
    }

    return next;
}

function addMemberVertexFromGlobal(
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
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: globalGraph.getAttributes().degreeLimitMember
    });
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
    const weight = getEdgeWeight(globalGraph, a, b);

    if (tree.hasEdge(a, b)) {
        return;
    }

    tree.addEdge(a, b, {
        from: a,
        to: b,
        weight
    });
}
