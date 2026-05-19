import { GraphInfo, GraphInfoSnapshot } from './shared-graph-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import * as vivaldiService from './vivaldi-service.ts';
import * as coreAlgorithms from './graph/core-node-algorithms.ts';
import { mddlOTTC, relaxDegreeByOne } from './tree/mddl-ottc.ts';
import * as createGraph from './graph/create-graph.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as graphsRepository from './repository/graphs-repository.ts';
import { DEFAULT_GRAPH_PROP, DEFAULT_K_CORE_NODES } from './algo-props.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

export const GLOBAL_GRAPH_REF: GroupRef = {
    applicationId: 'global',
    workspaceId: 'global',
    groupId: DEFAULT_GRAPH_PROP.id,
};

export function computeGroupGraph(
    groupRef: GroupRef,
    isIncludeMeasured: boolean = false,
): Either<string, GraphInfoSnapshot> {
    const group = groupStateSnapshotsRepository.findGroupStateSnapshotByRef(groupRef);
    if (!group) {
        return Either.ofLeft('Group not found: ' + groupRef.groupId);
    }

    return computeGroupGraphFromSnapshot(group, isIncludeMeasured);
}

export function computeLatestGroupGraphById(
    groupId: string,
    isIncludeMeasured: boolean = false,
): Either<string, GraphInfoSnapshot> {
    const group = groupStateSnapshotsRepository.findLatestGroupSnapshotById(groupId);
    if (!group) {
        return Either.ofLeft('Group not found: ' + groupId);
    }

    return computeGroupGraphFromSnapshot(group, isIncludeMeasured);
}

function computeGroupGraphFromSnapshot(
    group: GroupSnapshot,
    isIncludeMeasured: boolean,
): Either<string, GraphInfoSnapshot> {
    const memberSessionIds = [...new Set(group.activeSessions.map((session) => session.sessionId))];
    const groupRef = group.group;

    return Either.ofRight(
        {
            groupRef,
            predicted: toPredictedGroupGraph(memberSessionIds, groupRef),
            measured: isIncludeMeasured ? toMeasuredGroupGraph(memberSessionIds, groupRef) : undefined,
            createdAtEpochMs: Date.now(),
            version: 1,
        },
    );
}

export function computeGlobalGraphAndCacheIt() {
    const graphInfoSnapshot = computeGlobalGraph(
        [
            ...new Set(
                clientStateSnapshotsRepository.getAllClientStateSnapshots()
                    .flatMap((snapshot) => snapshot.activeSessions.map((session) => session.sessionId)),
            ),
        ],
        true,
    );

    graphsRepository.setGraph(graphInfoSnapshot);
    return graphInfoSnapshot;
}

export function computeGlobalGraph(
    allNodes: readonly string[],
    isIncludeMeasured: boolean = false,
): GraphInfoSnapshot {
    return {
        groupRef: GLOBAL_GRAPH_REF,
        predicted: toPredictedGroupGraph(allNodes, GLOBAL_GRAPH_REF),
        measured: isIncludeMeasured ? toMeasuredGroupGraph(allNodes, GLOBAL_GRAPH_REF) : undefined,
        createdAtEpochMs: Date.now(),
        version: 1,
    };
}

function toMeasuredGroupGraph(nodes: readonly string[], groupRef: GroupRef): GraphInfo {
    const measuredGraph = createGraph.toMeasuredGraph(DEFAULT_GRAPH_PROP);
    const measuredCoreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        measuredGraph,
        DEFAULT_K_CORE_NODES,
    );

    return {
        groupRef,
        graph: measuredGraph,
        coreNodes: measuredCoreNodes,
        groupGraph:
        mddlOTTC(measuredGraph, measuredCoreNodes[0], new Set([...nodes]), relaxDegreeByOne).tree,
    };
}

function toPredictedGroupGraph(nodes: readonly string[], groupRef: GroupRef): GraphInfo {
    const predictedGraph = vivaldiService.toPredictedGraphFromIds(nodes, DEFAULT_GRAPH_PROP);
    const coreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        predictedGraph,
        DEFAULT_K_CORE_NODES,
    );

    return {
        groupRef,
        graph: predictedGraph,
        coreNodes: coreAlgorithms.kBestLocatedNodesFromGraphAverage(
            predictedGraph,
            DEFAULT_K_CORE_NODES,
        ),
        groupGraph: mddlOTTC(predictedGraph, coreNodes[0], new Set([...nodes]), relaxDegreeByOne).tree,
    };
}
