import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { readGroupMemberSessionIds } from '@shared/api/group-client-views.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DynamicMeshAlgo } from './mesh/group-dynamics-mesh-types.ts';
import { DEFAULT_GRAPH_PROP, MessageType, ReconfigAlgo } from './algo-props.ts';
import { TreeGraph, VertexId, WeightedGraph } from './graph-props.ts';
import { InsertToMeshComputedDto, InsertToMeshInputDto, } from './mesh/insert-mesh-algs.ts';
import { CoreSelectionAlgo, findWCNodes, } from './graph/steiner-core-algorithms.ts';
import { removeVertexFromTree } from './remove/remove-dynamics-facade.ts';
import { compGraph } from './complete-graph/complete-graph-service.ts';
import { GraphAlgo } from './complete-graph/complete-graph-types.ts';
import { generateSizeOfSteinerSet } from './graph/graph-size-algorithms.ts';
import { PruneGraphAlgo } from './graph/prune-graph.ts';
import { kMDDLOTTCTree } from './mesh/k-mddl-ottc.ts';
import { diameterDistance } from './graph/graph-algs.ts';

export type GlobalMeshArgs = {
    meshParamK: number;
    insertAlgo: DynamicMeshAlgo;
    removeAlgo: DynamicMeshAlgo;
    diameterBound: number;
    reconfigAlgo: ReconfigAlgo;
};

export type MeshAlgorithmRunner = (
    input: InsertToMeshInputDto,
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

export type ProcessGroupUpdateMeshResult = {
    input: UpdateGroupMeshInputDto;
    elapsedMs: number;
    reconfigured: boolean;
    mesh: WeightedGraph;
};

export function updateGroupMesh(
    input: UpdateGroupMeshInputDto,
): ProcessGroupUpdateMeshResult {
    const started = performance.now();
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    let updatedMesh: WeightedGraph;

    switch (input.type) {
        case MessageType.TO_SERVER_ENTER: {
            const result = input.deps.insertMeshAlgorithmTimed(
                {
                    globalGraph: input.globalGraph,
                    groupGraph: input.groupGraph,
                    actionVertexId: input.fromNode,
                    numberOfMembers: memberSessionIds.length,
                    k: input.globalArgs.meshParamK,
                    algo: input.globalArgs.insertAlgo,
                },
            );

            updatedMesh = result.groupGraph;

            break;
        }

        case MessageType.TO_SERVER_LEAVE: {
            const result = removeVertexFromTree({
                globalGraph: input.globalGraph,
                groupGraph: input.groupGraph,
                actionVertexId: input.fromNode,
                treeAlgo: 'REMOVE_TRY_REPLACE_PRUNE_MC',
                steinerCandidates: new Set(input.globalGraph.nodes() as string[]),
                coreSelectionAlgo: CoreSelectionAlgo.CENTER_SELECTION,
                selectSteinerCandidate: (ctx, adjacent) => {
                    const candidates = findWCNodes(
                        ctx.globalGraph,
                        ctx.steinerCandidates,
                        adjacent,
                        new Set(ctx.groupGraph.nodes() as string[]),
                        1,
                        CoreSelectionAlgo.CENTER_SELECTION,
                    );

                    return candidates[0];
                },
            });

            updatedMesh = result.graph;
            break;
        }

        default:
            throw new Error(`Unsupported message type: ${input.type}`);
    }

    const reconfigured = doReconfigMesh(input);

    return {
        input: input,
        elapsedMs: performance.now() - started,
        reconfigured: reconfigured.right !== undefined,
        mesh: reconfigured.right !== undefined ? reconfigured.right : updatedMesh,
    };
}

export function doReconfigMesh(
    input: UpdateGroupMeshInputDto,
): Either<boolean, WeightedGraph> {
    const memberSessionIds = readGroupMemberSessionIds(input.group);

    if (memberSessionIds.length < 5) {
        return Either.ofLeft(false);
    }

    switch (input.globalArgs.reconfigAlgo) {
        case ReconfigAlgo.TEST_OPTIMAL_PAIR_WISE: {
            const meshDiameter = diameterDistance(input.globalGraph);

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
                                isSteinerAlgo: true,
                            },
                        );
                    },
                },
            });

            // TODO: Add option to prune completeGraph

            const src = findWCNodes(
                completeGraphResult.graph,
                groupMembers,
                groupMembers,
                new Set(),
                1,
                CoreSelectionAlgo.CENTER_SELECTION,
            ).at(0);

            if (src === undefined) {
                console.warn('Could not find source node for mesh');
                return Either.ofLeft(false);
            }

            const undirectedGraph = kMDDLOTTCTree(
                completeGraphResult.graph,
                input.globalArgs.meshParamK,
                src,
            );

            return Either.ofRight(undirectedGraph);
        }

        case ReconfigAlgo.NO_RECONFIG_ALGO:
        default:
            return Either.ofLeft(false);
    }
}
