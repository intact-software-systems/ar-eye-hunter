import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_GRAPH_PROP, DEFAULT_K_CORE_NODES } from './algo-props.ts';
import type { WeightedGraph } from './graph-props.ts';
import * as coreAlgorithms from './graph/core-node-algorithms.ts';
import * as createGraph from './graph/create-graph.ts';
import * as graphsRepository from './repository/graphs-repository.ts';
import { GraphInfo, GraphInfoSnapshot } from './shared-graph-types.ts';
import { createEmptyTreeLike, mddlOTTC, relaxDegreeByOne } from './tree/mddl-ottc.ts';
import * as vivaldiService from './vivaldi-service.ts';

export const GLOBAL_GRAPH_REF: GroupRef = {
    applicationId: 'global',
    workspaceId: 'global',
    groupId: DEFAULT_GRAPH_PROP.id
};

export const SCOPED_GLOBAL_GRAPH_GROUP_ID = '__global__';

export type PredictedGraphComputeOptions = Readonly<{
    predictedDegreeLimit?: number;
}>;

export function toScopedGlobalGraphRef(scope: StateScope): GroupRef {
    return {
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        groupId: SCOPED_GLOBAL_GRAPH_GROUP_ID
    };
}

export function computeGroupGraph(
    groupRef: GroupRef,
    isIncludeMeasured: boolean = false
): Either<string, GraphInfoSnapshot> {
    const group = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(groupRef);
    if (!group) {
        return Either.ofLeft('Group not found: ' + groupRef.groupId);
    }

    return computeGroupGraphFromSnapshot(group, isIncludeMeasured);
}

function computeGroupGraphFromSnapshot(
    group: GroupSnapshot,
    isIncludeMeasured: boolean
): Either<string, GraphInfoSnapshot> {
    const memberSessionIds = [...new Set(group.activeSessions.map((session) => session.sessionId))];
    const groupRef = group.group;

    return Either.ofRight(
        {
            groupRef,
            predicted: toPredictedGroupGraph(memberSessionIds, groupRef),
            measured: isIncludeMeasured ? toMeasuredGroupGraph(memberSessionIds, groupRef) : undefined,
            createdAtEpochMs: Date.now(),
            version: 1
        }
    );
}

export function computeGlobalGraphAndCacheIt(
    options: PredictedGraphComputeOptions = {}
) {
    const graphInfoSnapshot = computeGlobalGraph(
        [
            ...new Set(
                clientStateSnapshotsRepository.getAllClientStateSnapshots()
                    .flatMap((snapshot) => snapshot.activeSessions.map((session) => session.sessionId))
            )
        ],
        true,
        options
    );

    graphsRepository.setGraph(graphInfoSnapshot);
    return graphInfoSnapshot;
}

export function computeScopedGlobalGraphAndCacheIt(
    scope: StateScope,
    isIncludeMeasured: boolean = false,
    options: PredictedGraphComputeOptions = {}
): GraphInfoSnapshot {
    const graphInfoSnapshot = computeScopedGlobalGraph(
        scope,
        [
            ...new Set(
                clientStateSnapshotsRepository.getAllClientStateSnapshots()
                    .filter((snapshot) => isSameGroupScope(snapshot.principal, scope))
                    .flatMap((snapshot) =>
                        snapshot.activeSessions
                            .filter((session) =>
                                session.status === 'active' &&
                                isSameGroupScope(session, scope)
                            )
                            .map((session) => session.sessionId)
                    )
            )
        ],
        isIncludeMeasured,
        options
    );

    graphsRepository.setGraph(graphInfoSnapshot);
    return graphInfoSnapshot;
}

export function computeGlobalGraph(
    allNodes: readonly string[],
    isIncludeMeasured: boolean = false,
    options: PredictedGraphComputeOptions = {}
): GraphInfoSnapshot {
    return {
        groupRef: GLOBAL_GRAPH_REF,
        predicted: toPredictedGroupGraph(allNodes, GLOBAL_GRAPH_REF, options),
        measured: isIncludeMeasured ? toMeasuredGroupGraph(allNodes, GLOBAL_GRAPH_REF) : undefined,
        createdAtEpochMs: Date.now(),
        version: 1
    };
}

export function computeScopedGlobalGraph(
    scope: StateScope,
    allNodes: readonly string[],
    isIncludeMeasured: boolean = false,
    options: PredictedGraphComputeOptions = {}
): GraphInfoSnapshot {
    const groupRef = toScopedGlobalGraphRef(scope);
    return {
        groupRef,
        predicted: toPredictedGroupGraph(allNodes, groupRef, options),
        measured: isIncludeMeasured ? toMeasuredGroupGraph(allNodes, groupRef) : undefined,
        createdAtEpochMs: Date.now(),
        version: 1
    };
}

function toMeasuredGroupGraph(nodes: readonly string[], groupRef: GroupRef): GraphInfo {
    const measuredGraph = createGraph.toMeasuredGraph(DEFAULT_GRAPH_PROP);
    const measuredCoreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        measuredGraph,
        DEFAULT_K_CORE_NODES
    );

    return {
        groupRef,
        graph: measuredGraph,
        coreNodes: measuredCoreNodes,
        groupGraph: createAvailableNodeGroupTree(
            measuredGraph,
            nodes,
            measuredCoreNodes
        )
    };
}

function toPredictedGroupGraph(
    nodes: readonly string[],
    groupRef: GroupRef,
    options: PredictedGraphComputeOptions = {}
): GraphInfo {
    const predictedGraph = options.predictedDegreeLimit !== undefined
        ? vivaldiService.toDegreeCappedPredictedGraphFromIds(
            nodes,
            DEFAULT_GRAPH_PROP,
            { degreeLimit: options.predictedDegreeLimit }
        )
        : vivaldiService.toPredictedGraphFromIds(nodes, DEFAULT_GRAPH_PROP);
    const coreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        predictedGraph,
        DEFAULT_K_CORE_NODES
    );

    return {
        groupRef,
        graph: predictedGraph,
        coreNodes,
        groupGraph: createAvailableNodeGroupTree(
            predictedGraph,
            nodes,
            coreNodes
        )
    };
}

function createAvailableNodeGroupTree(
    graph: WeightedGraph,
    nodes: readonly string[],
    coreNodes: readonly string[]
): WeightedGraph {
    const availableNodeSet = new Set(
        nodes.filter((node) => graph.hasNode(node))
    );
    const source = coreNodes.find((node) => availableNodeSet.has(node)) ??
        (availableNodeSet.values().next().value as string | undefined);
    const tree = createEmptyTreeLike(graph);
    if (source === undefined) {
        return tree;
    }

    if (availableNodeSet.size === 1) {
        tree.addNode(source, { ...graph.getNodeAttributes(source) });
        return tree;
    }

    return mddlOTTC(
        graph,
        source,
        availableNodeSet,
        relaxDegreeByOne
    ).tree;
}
