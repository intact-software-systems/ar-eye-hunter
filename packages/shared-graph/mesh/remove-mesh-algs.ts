import { TreeGraph, VertexId, VertexState, } from '../graph-props.ts';
import { DynamicMeshAlgo } from './group-dynamics-mesh-types.ts';
import { GroupInformation } from '../algo-props.ts';

export type RemoveDynamicsLike = {
    rvLeaf(): void;
    rvTryReplaceNaive(): void;
    rvTRMDDLN(): void;
    rvTryReplace(): void;
    rvUnusedSP(): void;
    removeVertex(algo: string): void;
    treeAlgo(algo: string): void;
};

export type CreateRemoveDynamicsFn = (
    globalGraph: TreeGraph,
    groupInfo: GroupInformation,
    fifoSteiner: unknown,
    actionVertexId: VertexId,
) => RemoveDynamicsLike;

export type RemoveMeshAlgorithmResult = {
    elapsedMs: number;
    validMesh: boolean;
};

export type RemoveFromMeshInputDto = {
    globalGraph: TreeGraph;
    groupInfo: GroupInformation;
    fifoSteiner: unknown;
    actionVertexId: VertexId;
    k: number;
    algo: DynamicMeshAlgo;
}

export function removeFromMesh(
    globalGraph: TreeGraph,
    groupInfo: GroupInformation,
    fifoSteiner: unknown,
    actionVertexId: VertexId,
    k: number,
    algo: DynamicMeshAlgo,
    createRemoveDynamics: CreateRemoveDynamicsFn,
): RemoveMeshAlgorithmResult {
    const started = performance.now();

    removeMeshAlgorithm(
        globalGraph,
        groupInfo,
        fifoSteiner,
        actionVertexId,
        k,
        algo,
        createRemoveDynamics,
    );

    const elapsedMs = performance.now() - started;

    return {
        elapsedMs,
        validMesh: isValidMesh(groupInfo.getTreeStructure()),
    };
}

export function removeMeshAlgorithm(
    globalGraph: TreeGraph,
    groupInfo: GroupInformation,
    fifoSteiner: unknown,
    actionVertexId: VertexId,
    k: number,
    algo: DynamicMeshAlgo,
    createRemoveDynamics: CreateRemoveDynamicsFn,
): number {
    const groupGraph = groupInfo.getTreeStructure();
    const rd = createRemoveDynamics(globalGraph, groupInfo, fifoSteiner, actionVertexId);

    const started = performance.now();

    if (groupInfo.getMembers().size <= 1) {
        removeLastMeshVertex(groupGraph, actionVertexId);
    } else if (groupGraph.degree(actionVertexId) === 1) {
        rd.rvLeaf();
    } else {
        let again = true;
        let currentAlgo = algo;

        while (again) {
            again = false;

            try {
                switch (currentAlgo) {
                    case DynamicMeshAlgo.K_REMOVE_MDDL:
                        kRemoveMDDL(rd, actionVertexId, k);
                        break;

                    case DynamicMeshAlgo.K_REMOVE_MC:
                        kRemoveMC(rd, actionVertexId, k);
                        break;

                    case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_MC_NAIVE:
                        rd.rvTryReplaceNaive();
                        break;

                    case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_MDDL_NAIVE:
                        rd.rvTRMDDLN();
                        break;

                    case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_PRUNE_MDDL:
                        rd.treeAlgo('REMOVE_TRY_REPLACE_PRUNE_MDDL');
                        rd.rvTryReplace();
                        break;

                    case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_PRUNE_MC:
                        rd.treeAlgo('REMOVE_TRY_REPLACE_PRUNE_MC');
                        rd.rvTryReplace();
                        break;

                    default:
                        throw new Error(`removeMeshAlgorithm: unsupported algorithm ${currentAlgo}`);
                }
            } catch (_error) {
                again = true;
                currentAlgo = DynamicMeshAlgo.K_REMOVE_MC;
            }
        }
    }

    rd.rvUnusedSP();

    return performance.now() - started;
}

export function kRemoveMDDL(
    rd: RemoveDynamicsLike,
    actionVertexId: VertexId,
    k: number,
): void {
    void actionVertexId;
    void k;

    rd.removeVertex('REMOVE_MINIMUM_DIAMETER_EDGE');
}

export function kRemoveMC(
    rd: RemoveDynamicsLike,
    actionVertexId: VertexId,
    k: number,
): void {
    void actionVertexId;
    void k;

    rd.removeVertex('REMOVE_MINIMUM_COST_EDGE');
}

function removeLastMeshVertex(
    groupGraph: TreeGraph,
    actionVertexId: VertexId,
): void {
    if (groupGraph.hasNode(actionVertexId)) {
        groupGraph.dropNode(actionVertexId);
    }

    clearSteinerVertices(groupGraph);
    clearAllEdges(groupGraph);
}

function clearSteinerVertices(groupGraph: TreeGraph): void {
    const nodes = groupGraph.nodes() as VertexId[];

    for (const node of nodes) {
        const attrs = groupGraph.getNodeAttributes(node);
        if (attrs.state === VertexState.STEINER) {
            groupGraph.dropNode(node);
        }
    }
}

function clearAllEdges(groupGraph: TreeGraph): void {
    const edges = groupGraph.edges() as string[];
    for (const edgeKey of edges) {
        groupGraph.dropEdge(edgeKey);
    }
}

function isValidMesh(groupGraph: TreeGraph): boolean {
    const nodes = groupGraph.nodes() as VertexId[];
    if (nodes.length <= 1) {
        return true;
    }

    const visited = new Set<VertexId>();
    const queue: VertexId[] = [nodes[0]];
    visited.add(nodes[0]);

    while (queue.length > 0) {
        const current = queue.shift()!;

        for (const neighbor of groupGraph.neighbors(current) as VertexId[]) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                queue.push(neighbor);
            }
        }
    }

    return visited.size === nodes.length;
}