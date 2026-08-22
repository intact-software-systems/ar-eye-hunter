import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { UndirectedGraph } from 'graphology';
import { DEFAULT_GRAPH_PROP, MessageType, ReconfigAlgo } from './algo-props.ts';
import { compGraph } from './complete-graph/complete-graph-service.ts';
import { GraphAlgo } from './complete-graph/complete-graph-types.ts';
import {
    compareVertexIds,
    TreeGraph,
    VertexId,
    WeightedGraph,
    type EdgeProp,
    type GraphProp,
    type VertexProp
} from './graph-props.ts';
import { diameterDistance } from './graph/graph-algs.ts';
import { generateSizeOfSteinerSet } from './graph/graph-size-algorithms.ts';
import { PruneGraphAlgo } from './graph/prune-graph.ts';
import { CoreSelectionAlgo, findWCNodes } from './graph/steiner-core-algorithms.ts';
import { validateGroupTopology, type GroupTopologyValidationResult } from './group-topology-validation.ts';
import { DynamicMeshAlgo } from './mesh/group-dynamics-mesh-types.ts';
import { InsertToMeshComputedDto, InsertToMeshInputDto } from './mesh/insert-mesh-algs.ts';
import { kMDDLOTTCTree } from './mesh/k-mddl-ottc.ts';
import { removeVertexFromTree } from './remove/remove-dynamics-facade.ts';
import type { DynamicTreeAlgo } from './remove/remove-dynamics-types.ts';

export type GlobalMeshArgs = {
    meshParamK: number;
    insertAlgo: DynamicMeshAlgo;
    removeAlgo: DynamicMeshAlgo;
    diameterBound: number;
    reconfigAlgo: ReconfigAlgo;
};

export type MeshAlgorithmRunner = (
    input: InsertToMeshInputDto
) => InsertToMeshComputedDto;

export type ProcessGroupUpdateMeshDeps = {
    insertMeshAlgorithmTimed: MeshAlgorithmRunner;
};

export type UpdateGroupMeshInputDto = {
    type: MessageType;
    fromNode: VertexId;
    group: GroupSnapshot;
    groupGraph: TreeGraph;
    globalGraph: WeightedGraph;
    fifoSteiner: ReadonlySet<string>;
    globalArgs: GlobalMeshArgs;
    deps: ProcessGroupUpdateMeshDeps;
};

export type CreateGroupMeshInputDto = {
    group: GroupSnapshot;
    globalGraph: WeightedGraph;
    globalArgs: GlobalMeshArgs;
    deps: ProcessGroupUpdateMeshDeps;
    maxDegree?: number;
    orderMemberSessionIds?: (
        memberSessionIds: readonly VertexId[],
        globalGraph: WeightedGraph
    ) => readonly VertexId[];
};

export type CreateGroupMeshComputedDto = {
    input: CreateGroupMeshInputDto;
    elapsedMs: number;
    success: boolean;
    mesh: WeightedGraph;
    validation: GroupTopologyValidationResult;
    failedAtMemberId?: VertexId;
    reason?: string;
};

export type ProcessGroupUpdateMeshResult = {
    input: UpdateGroupMeshInputDto;
    elapsedMs: number;
    reconfigured: boolean;
    mesh: WeightedGraph;
    removeAttemptedAlgo?: DynamicTreeAlgo;
    removeUsedFallback?: boolean;
    reconfigReason?: string;
};

export function createGroupMesh(
    input: CreateGroupMeshInputDto
): CreateGroupMeshComputedDto {
    const started = performance.now();
    const memberSessionIds = uniqueSessionIds(readGroupMemberSessionIds(input.group));
    // Mesh shape is a function of insertion order; the default is canonical
    // vertex order so identical member sets build identical meshes.
    const orderedMembers = input.orderMemberSessionIds?.(
        memberSessionIds,
        input.globalGraph
    ) ?? [...memberSessionIds].sort(compareVertexIds);
    let mesh = createEmptyGroupGraphLike(input.globalGraph);

    if (orderedMembers.length === 0) {
        const validation = validateGroupTopology({
            graph: mesh,
            activeSessionIds: new Set(memberSessionIds),
            maxDegree: input.maxDegree
        });

        return {
            input,
            elapsedMs: performance.now() - started,
            success: validation.valid,
            mesh,
            validation
        };
    }

    for (const memberId of orderedMembers) {
        if (!input.globalGraph.hasNode(memberId)) {
            const validation = validateGroupTopology({
                graph: mesh,
                activeSessionIds: new Set(memberSessionIds),
                maxDegree: input.maxDegree
            });

            return {
                input,
                elapsedMs: performance.now() - started,
                success: false,
                mesh,
                validation,
                failedAtMemberId: memberId,
                reason: `Missing member ${memberId} in global graph`
            };
        }

        try {
            const result = input.deps.insertMeshAlgorithmTimed({
                globalGraph: input.globalGraph,
                groupGraph: mesh,
                actionVertexId: memberId,
                numberOfMembers: mesh.nodes().length + 1,
                k: input.globalArgs.meshParamK,
                algo: input.globalArgs.insertAlgo
            });

            mesh = result.groupGraph;
        }
        catch (error) {
            const validation = validateGroupTopology({
                graph: mesh,
                activeSessionIds: new Set(memberSessionIds),
                maxDegree: input.maxDegree
            });

            return {
                input,
                elapsedMs: performance.now() - started,
                success: false,
                mesh,
                validation,
                failedAtMemberId: memberId,
                reason: error instanceof Error ? error.message : 'Mesh rebuild failed'
            };
        }
    }

    const validation = validateGroupTopology({
        graph: mesh,
        activeSessionIds: new Set(memberSessionIds),
        maxDegree: input.maxDegree
    });

    return {
        input,
        elapsedMs: performance.now() - started,
        success: validation.valid,
        mesh,
        validation,
        reason: validation.valid ? undefined : 'Mesh validation failed'
    };
}

export function updateGroupMesh(
    input: UpdateGroupMeshInputDto
): ProcessGroupUpdateMeshResult {
    const started = performance.now();
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    let updatedMesh: WeightedGraph;
    let removeAttemptedAlgo: DynamicTreeAlgo | undefined;
    let removeUsedFallback: boolean | undefined;

    switch (input.type) {
        case MessageType.TO_SERVER_ENTER: {
            const result = input.deps.insertMeshAlgorithmTimed(
                {
                    globalGraph: input.globalGraph,
                    groupGraph: input.groupGraph,
                    actionVertexId: input.fromNode,
                    numberOfMembers: memberSessionIds.length,
                    k: input.globalArgs.meshParamK,
                    algo: input.globalArgs.insertAlgo
                }
            );

            updatedMesh = result.groupGraph;

            break;
        }

        case MessageType.TO_SERVER_LEAVE: {
            const treeAlgo = meshRemoveAlgoToTreeAlgo(input.globalArgs.removeAlgo);
            const result = removeVertexFromTree({
                globalGraph: input.globalGraph,
                groupGraph: input.groupGraph,
                actionVertexId: input.fromNode,
                treeAlgo,
                steinerCandidates: new Set(input.globalGraph.nodes() as string[]),
                coreSelectionAlgo: CoreSelectionAlgo.CENTER_SELECTION,
                selectSteinerCandidate: (ctx, adjacent) => {
                    const candidates = findWCNodes(
                        ctx.globalGraph,
                        ctx.steinerCandidates,
                        adjacent,
                        new Set(ctx.groupGraph.nodes() as string[]),
                        1,
                        CoreSelectionAlgo.CENTER_SELECTION
                    );

                    return candidates[0];
                }
            });

            updatedMesh = result.graph;
            removeAttemptedAlgo = result.attemptedAlgo;
            removeUsedFallback = result.usedFallback;
            break;
        }

        default:
            throw new Error(`Unsupported message type: ${input.type}`);
    }

    const reconfigured = doReconfigMesh({
        ...input,
        groupGraph: updatedMesh
    });

    return {
        input: input,
        elapsedMs: performance.now() - started,
        reconfigured: reconfigured.right !== undefined,
        mesh: reconfigured.right !== undefined ? reconfigured.right : updatedMesh,
        removeAttemptedAlgo,
        removeUsedFallback,
        reconfigReason: reconfigured.right !== undefined ? undefined : 'not-needed-or-failed'
    };
}

export function doReconfigMesh(
    input: UpdateGroupMeshInputDto
): Either<boolean, WeightedGraph> {
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    if (memberSessionIds.length < 5) {
        return Either.ofLeft(false);
    }

    switch (input.globalArgs.reconfigAlgo) {
        case ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE: {
            const meshDiameter = diameterDistance(input.groupGraph);

            if (meshDiameter <= input.globalArgs.diameterBound) {
                return Either.ofLeft(false);
            }

            const groupMembers = new Set(memberSessionIds);

            const completeGraphResult = compGraph({
                globalGraph: input.globalGraph,
                groupMembers: groupMembers,
                fifoSteinerSet: input.fifoSteiner,
                algo: GraphAlgo.COMPLETE_MEMBER_GRAPH_NEW_STEINER,
                update: false,
                wcnAlgo: CoreSelectionAlgo.CENTER_SELECTION,
                deps: {
                    findWCNodes,
                    generateSizeOfSteinerSet: (groupSize) => {
                        return generateSizeOfSteinerSet(
                            {
                                members: groupSize,
                                steiner: 2,
                                steinerMemberSize: 0,
                                steinerMemberRatio: 0,
                                degreeConstraint: DEFAULT_GRAPH_PROP.degreeLimitMember,
                                degreeConstraintSP: DEFAULT_GRAPH_PROP.degreeLimitSteiner,
                                simPruneAlgo: PruneGraphAlgo.ADD_CORE_LINKS_OPTIMIZED,
                                simGraphAlgo: GraphAlgo.COMPLETE_MEMBER_GRAPH_KEEP_STEINER,
                                isSteinerAlgo: true
                            }
                        );
                    }
                }
            });

            // TODO: Add option to prune completeGraph

            const src = findWCNodes(
                completeGraphResult.graph,
                groupMembers,
                groupMembers,
                new Set(),
                1,
                CoreSelectionAlgo.CENTER_SELECTION
            ).at(0);

            if (src === undefined) {
                console.warn('Could not find source node for mesh');
                return Either.ofLeft(false);
            }

            const undirectedGraph = kMDDLOTTCTree(
                completeGraphResult.graph,
                input.globalArgs.meshParamK,
                src
            );

            return Either.ofRight(undirectedGraph);
        }

        case ReconfigAlgo.NO_RECONFIG_ALGO:
        default:
            return Either.ofLeft(false);
    }
}

export function meshRemoveAlgoToTreeAlgo(algo: DynamicMeshAlgo): DynamicTreeAlgo {
    switch (algo) {
        case DynamicMeshAlgo.K_REMOVE_MDDL:
            return 'REMOVE_MINIMUM_DIAMETER_EDGE';
        case DynamicMeshAlgo.K_REMOVE_MC:
            return 'REMOVE_MINIMUM_COST_EDGE';
        case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_MDDL_NAIVE:
            return 'REMOVE_TRY_REPLACE_MDDL_NAIVE';
        case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_PRUNE_MDDL:
            return 'REMOVE_TRY_REPLACE_PRUNE_MDDL';
        case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_PRUNE_MC:
            return 'REMOVE_TRY_REPLACE_PRUNE_MC';
        case DynamicMeshAlgo.K_REMOVE_TRY_REPLACE_MC_NAIVE:
            return 'REMOVE_TRY_REPLACE_PRUNE_MC';
        case DynamicMeshAlgo.NO_DYNAMIC_MESH_ALGO:
            return 'NO_DYNAMIC_TREE_ALGO';
        default:
            throw new Error(`Unsupported mesh remove algorithm: ${algo}`);
    }
}

function uniqueSessionIds(sessionIds: readonly VertexId[]): readonly VertexId[] {
    return [...new Set(sessionIds)];
}

function createEmptyGroupGraphLike(inputGraph: WeightedGraph): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(inputGraph.getAttributes());
    return graph;
}
