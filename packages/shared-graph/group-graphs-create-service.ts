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

export function computeGroupGraph(
    groupId: string,
    isIncludeMeasured: boolean = false,
): Either<string, GraphInfoSnapshot> {
    const group = groupStateSnapshotsRepository.findGroupStateSnapshotById(groupId);
    if (!group) {
        return Either.ofLeft('Group not found: ' + groupId);
    }

    const memberSessionIds = [...new Set(group.activeSessions.map((session) => session.sessionId))];

    return Either.ofRight(
        {
            graphId: groupId,
            predicted: toPredictedGroupGraph(memberSessionIds, groupId),
            measured: isIncludeMeasured ? toMeasuredGroupGraph(memberSessionIds, groupId) : undefined,
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

    graphsRepository.setGraphById(DEFAULT_GRAPH_PROP.id, graphInfoSnapshot);
    return graphInfoSnapshot;
}

export function computeGlobalGraph(
    allNodes: readonly string[],
    isIncludeMeasured: boolean = false,
): GraphInfoSnapshot {
    return {
        graphId: DEFAULT_GRAPH_PROP.id,
        predicted: toPredictedGroupGraph(allNodes, DEFAULT_GRAPH_PROP.id),
        measured: isIncludeMeasured ? toMeasuredGroupGraph(allNodes, DEFAULT_GRAPH_PROP.id) : undefined,
        createdAtEpochMs: Date.now(),
        version: 1,
    };
}

function toMeasuredGroupGraph(nodes: readonly string[], graphId: string): GraphInfo {
    const measuredGraph = createGraph.toMeasuredGraph(DEFAULT_GRAPH_PROP);
    const measuredCoreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        measuredGraph,
        DEFAULT_K_CORE_NODES,
    );

    return {
        graphId: graphId,
        graph: measuredGraph,
        coreNodes: measuredCoreNodes,
        groupGraph:
        mddlOTTC(measuredGraph, measuredCoreNodes[0], new Set([...nodes]), relaxDegreeByOne).tree,
    };
}

function toPredictedGroupGraph(nodes: readonly string[], graphId: string): GraphInfo {
    const predictedGraph = vivaldiService.toPredictedGraphFromIds(nodes, DEFAULT_GRAPH_PROP);
    const coreNodes = coreAlgorithms.kBestLocatedNodesFromGraphAverage(
        predictedGraph,
        DEFAULT_K_CORE_NODES,
    );

    return {
        graphId: graphId,
        graph: predictedGraph,
        coreNodes: coreAlgorithms.kBestLocatedNodesFromGraphAverage(
            predictedGraph,
            DEFAULT_K_CORE_NODES,
        ),
        groupGraph: mddlOTTC(predictedGraph, coreNodes[0], new Set([...nodes]), relaxDegreeByOne).tree,
    };
}
