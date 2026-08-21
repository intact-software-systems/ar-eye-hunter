import { compareVertexIds, MeshGraph, VertexId, VertexState, VertexType, WeightedGraph } from '../graph-props.ts';
import { cloneGraph, isValidMesh, worstCaseDist } from '../graph/graph-algs.ts';
import { DynamicMeshAlgo } from './group-dynamics-mesh-types.ts';

export type InsertToMeshInputDto = {
    globalGraph: MeshGraph;
    groupGraph: WeightedGraph;
    actionVertexId: VertexId;
    numberOfMembers: number;
    k: number;
    algo: DynamicMeshAlgo;
};

export type InsertToMeshComputedDto = {
    input: InsertToMeshInputDto;
    elapsedMs: number;
    validMesh: boolean;
    groupGraph: WeightedGraph;
};

export function insertToMesh(input: InsertToMeshInputDto): InsertToMeshComputedDto {
    const started = performance.now();

    const groupGraph = insertMeshAlgorithm(input);

    return {
        input: input,
        elapsedMs: performance.now() - started,
        validMesh: isValidMesh(groupGraph),
        groupGraph: groupGraph
    };
}

export function insertMeshAlgorithm(input: InsertToMeshInputDto): WeightedGraph {
    const groupGraph = cloneGraph(input.groupGraph);

    if (input.numberOfMembers == 1) {
        ensureEmptyFirstInsert(groupGraph);
        insertMemberVertexFromGlobal(groupGraph, input.globalGraph, input.actionVertexId);
        return groupGraph;
    }

    if (groupGraph.hasNode(input.actionVertexId)) {
        const attrs = groupGraph.getNodeAttributes(input.actionVertexId);

        if (attrs.state !== VertexState.STEINER) {
            console.warn(`Vertex ${input.actionVertexId} already exists in group graph and is not STEINER.`);
            return groupGraph;
        }

        groupGraph.replaceNodeAttributes(
            input.actionVertexId,
            {
                ...attrs,
                type: VertexType.CLIENT,
                state: VertexState.MEMBER,
                degreeLimit: groupGraph.getAttributes().degreeLimitMember
            }
        );

        return groupGraph;
    }

    switch (input.algo) {
        case DynamicMeshAlgo.K_INSERT_MDDL:
            kInsertMDDL(input.globalGraph, groupGraph, input.actionVertexId, input.k);
            break;

        case DynamicMeshAlgo.K_INSERT_MC:
            kInsertMC(input.globalGraph, groupGraph, input.actionVertexId, input.k);
            break;

        case DynamicMeshAlgo.K_INSERT_MC_MDDL:
            kInsertMCandMDDL(input.globalGraph, groupGraph, input.actionVertexId, input.k);
            break;

        default:
            throw new Error(`insertMeshAlgorithm: unsupported algorithm ${input.algo}`);
    }

    return groupGraph;
}

export function kInsertMCandMDDL(
    globalGraph: MeshGraph,
    groupGraph: MeshGraph,
    actionVertexId: VertexId,
    k: number
): void {
    let mcEdges = 0;
    let mddlEdges = 0;

    if (k % 2 === 0) {
        mcEdges = k / 2;
        mddlEdges = k / 2;
    }
    else {
        mcEdges = (k + 1) / 2;
        mddlEdges = k - mcEdges;
    }

    kInsertMC(globalGraph, groupGraph, actionVertexId, mcEdges);
    kInsertMDDL(globalGraph, groupGraph, actionVertexId, mddlEdges);
}

export function kInsertMDDL(
    globalGraph: MeshGraph,
    groupGraph: MeshGraph,
    actionVertexId: VertexId,
    k: number
): void {
    const ranked: Array<{ score: number; node: VertexId; }> = [];

    for (const candidate of groupGraph.nodes() as VertexId[]) {
        if (candidate === actionVertexId) {
            continue;
        }

        if (getOutDegree(groupGraph, candidate) >= getDegreeConstraint(globalGraph, candidate)) {
            continue;
        }

        let worstCaseDistance = 0;
        if (getOutDegree(groupGraph, candidate) > 0) {
            worstCaseDistance = worstCaseDist(groupGraph, candidate);
        }

        const edgeWeight = getRequiredEdgeWeight(globalGraph, actionVertexId, candidate);
        const resultingEccentricity = edgeWeight + worstCaseDistance;

        ranked.push({
            score: resultingEccentricity,
            node: candidate
        });
    }

    if (ranked.length === 0) {
        throw new Error('kInsertMDDL failed: no feasible target vertices found.');
    }

    ranked.sort((a, b) => a.score - b.score || compareVertexIds(a.node, b.node));

    insertMemberVertexFromGlobal(groupGraph, globalGraph, actionVertexId);

    let inserted = 0;
    for (const entry of ranked) {
        if (inserted >= k) {
            break;
        }

        if (entry.node === actionVertexId) {
            throw new Error('kInsertMDDL: self-loop target selected unexpectedly.');
        }

        insertEdgeFromGlobal(groupGraph, globalGraph, actionVertexId, entry.node);
        inserted++;
    }
}

export function kInsertMC(
    globalGraph: MeshGraph,
    groupGraph: MeshGraph,
    actionVertexId: VertexId,
    k: number
): void {
    const ranked: Array<{ score: number; node: VertexId; }> = [];

    for (const candidate of groupGraph.nodes() as VertexId[]) {
        if (candidate === actionVertexId) {
            continue;
        }

        if (getOutDegree(groupGraph, candidate) >= getDegreeConstraint(globalGraph, candidate)) {
            continue;
        }

        const edgeWeight = getRequiredEdgeWeight(globalGraph, actionVertexId, candidate);
        ranked.push({
            score: edgeWeight,
            node: candidate
        });
    }

    if (ranked.length === 0) {
        throw new Error('kInsertMC failed: no feasible target vertices found.');
    }

    ranked.sort((a, b) => a.score - b.score || compareVertexIds(a.node, b.node));

    insertMemberVertexFromGlobal(groupGraph, globalGraph, actionVertexId);

    let inserted = 0;
    for (const entry of ranked) {
        if (inserted >= k) {
            break;
        }

        if (entry.node === actionVertexId) {
            throw new Error('kInsertMC: self-loop target selected unexpectedly.');
        }

        insertEdgeFromGlobal(groupGraph, globalGraph, actionVertexId, entry.node);
        inserted++;
    }
}

function ensureEmptyFirstInsert(groupGraph: MeshGraph): void {
    if (
        groupGraph.nodes().length !== 0 ||
        groupGraph.edges().length !== 0
    ) {
        throw new Error(
            'Expected empty group graph on first insert, but graph is not empty.'
        );
    }
}

function insertMemberVertexFromGlobal(
    groupGraph: MeshGraph,
    globalGraph: MeshGraph,
    vertexId: VertexId
): void {
    if (groupGraph.hasNode(vertexId)) {
        return;
    }

    const attrs = globalGraph.getNodeAttributes(vertexId);

    groupGraph.addNode(vertexId, {
        ...attrs,
        type: VertexType.CLIENT,
        state: VertexState.MEMBER,
        degreeLimit: groupGraph.getAttributes().degreeLimitMember
    });
}

function insertEdgeFromGlobal(
    groupGraph: MeshGraph,
    globalGraph: MeshGraph,
    a: VertexId,
    b: VertexId
): void {
    if (groupGraph.hasEdge(a, b)) {
        return;
    }

    const weight = getRequiredEdgeWeight(globalGraph, a, b);
    groupGraph.addEdge(a, b, {
        from: a,
        to: b,
        weight
    });
}

function getRequiredEdgeWeight(
    graph: MeshGraph,
    a: VertexId,
    b: VertexId
): number {
    const edgeKey = graph.edge(a, b);
    if (edgeKey === undefined) {
        throw new Error(`Missing required edge between ${a} and ${b} in global graph.`);
    }
    return graph.getEdgeAttribute(edgeKey, 'weight') as number;
}

function getDegreeConstraint(
    graph: MeshGraph,
    node: VertexId
): number {
    return graph.getNodeAttributes(node).degreeLimit;
}

function getOutDegree(
    graph: MeshGraph,
    node: VertexId
): number {
    return graph.degree(node);
}
