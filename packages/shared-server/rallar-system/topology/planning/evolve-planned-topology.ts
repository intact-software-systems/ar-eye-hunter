import { UndirectedGraph } from 'graphology';

import { MessageType, ReconfigAlgo } from '@shared-graph/algo-props.ts';
import type { EdgeProp, GraphProp, VertexProp, WeightedGraph } from '@shared-graph/graph-props.ts';
import { VertexState, VertexType } from '@shared-graph/graph-props.ts';
import { updateGroupMesh } from '@shared-graph/graphs-mesh-service.ts';
import { updateGroupTree } from '@shared-graph/graphs-tree-service.ts';
import { validateGroupTopology } from '@shared-graph/group-topology-validation.ts';
import { DynamicMeshAlgo } from '@shared-graph/mesh/group-dynamics-mesh-types.ts';
import { insertToMesh } from '@shared-graph/mesh/insert-mesh-algs.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot, RallarRtcTopologyKind } from '@shared/api/overlay-topology.ts';

import { compareRtcTopologyIdentifiers } from '../persistence/rtc-topology-identifiers.ts';
import { computeCanonicalTopologyPairWeight } from './canonical-topology-planning-input.ts';

export interface EvolvePlannedTopologyInput {
    readonly previous: RallarOverlayTopologySnapshot;
    readonly group: GroupSnapshot;
    readonly activeSessionIds: readonly string[];
    readonly globalGraph: WeightedGraph;
    readonly kind: Extract<RallarRtcTopologyKind, 'tree' | 'mesh'>;
    readonly degreeLimit: number;
    readonly meshParamK: number;
}

export type EvolvePlannedTopologyResult =
    | Readonly<{ outcome: 'planned'; nextHopsBySessionId: Record<string, readonly string[]>; }>
    | Readonly<{ outcome: 'full-rebuild'; reason: EvolvePlannedTopologyFullRebuildReason; }>;

export type EvolvePlannedTopologyFullRebuildReason =
    | 'delta-too-large'
    | 'update-failed'
    | 'invariant-violation';

/**
 * Evolves the previous accepted graph by the membership delta through the
 * incremental tree/mesh update algorithms, instead of rebuilding from
 * scratch. Structure preservation is the point: an unchanged member keeps its
 * edges, so browsers churn O(delta) connections per membership change. The
 * caller falls back to a full rebuild whenever this returns `full-rebuild`;
 * the invariant validator judges the evolved graph exactly like a fresh one.
 */
export function computeEvolvedTopologyNextHops(
    input: EvolvePlannedTopologyInput
): EvolvePlannedTopologyResult {
    const currentSessionIds = new Set(input.activeSessionIds);
    const previousSessionIds = new Set(input.previous.activeSessionIds);
    const addedSessionIds = input.activeSessionIds.filter(
        (sessionId) => !previousSessionIds.has(sessionId)
    );
    const removedSessionIds = input.previous.activeSessionIds.filter(
        (sessionId) => !currentSessionIds.has(sessionId)
    );

    const deltaBudget = Math.max(2, Math.ceil(input.previous.activeSessionIds.length / 4));
    if (addedSessionIds.length + removedSessionIds.length > deltaBudget) {
        return { outcome: 'full-rebuild', reason: 'delta-too-large' };
    }

    let evolved = reconstructPreviousGraph(input);
    try {
        for (const sessionId of removedSessionIds) {
            evolved = applyMembershipChange(input, evolved, {
                sessionId,
                type: MessageType.TO_SERVER_LEAVE
            });
        }
        for (const sessionId of addedSessionIds) {
            evolved = applyMembershipChange(input, evolved, {
                sessionId,
                type: MessageType.TO_SERVER_ENTER
            });
        }
    }
    catch {
        return { outcome: 'full-rebuild', reason: 'update-failed' };
    }

    const validation = validateGroupTopology({
        graph: evolved,
        activeSessionIds: currentSessionIds,
        maxDegree: input.degreeLimit
    });
    if (!validation.valid) {
        return { outcome: 'full-rebuild', reason: 'invariant-violation' };
    }

    return {
        outcome: 'planned',
        nextHopsBySessionId: Object.fromEntries(
            input.activeSessionIds.map((sessionId) => [
                sessionId,
                evolved.hasNode(sessionId) ? (evolved.neighbors(sessionId) as string[]).sort() : []
            ])
        )
    };
}

interface TopologyMembershipChange {
    readonly sessionId: string;
    readonly type: MessageType;
}

function applyMembershipChange(
    input: EvolvePlannedTopologyInput,
    graph: WeightedGraph,
    change: TopologyMembershipChange
): WeightedGraph {
    if (input.kind === 'tree') {
        return updateGroupTree({
            type: change.type,
            fromNode: change.sessionId,
            group: input.group,
            groupGraph: graph,
            globalGraph: input.globalGraph,
            globalArgs: {
                diameterBound: Number.POSITIVE_INFINITY,
                reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO
            }
        }).tree;
    }
    return updateGroupMesh({
        type: change.type,
        fromNode: change.sessionId,
        group: input.group,
        groupGraph: graph,
        globalGraph: input.globalGraph,
        fifoSteiner: new Set<string>(),
        globalArgs: {
            meshParamK: input.meshParamK,
            insertAlgo: DynamicMeshAlgo.K_INSERT_MC,
            removeAlgo: DynamicMeshAlgo.K_REMOVE_MC,
            diameterBound: Number.POSITIVE_INFINITY,
            reconfigAlgo: ReconfigAlgo.NO_RECONFIG_ALGO
        },
        deps: { insertMeshAlgorithmTimed: insertToMesh }
    }).mesh;
}

function reconstructPreviousGraph(input: EvolvePlannedTopologyInput): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(input.globalGraph.getAttributes());

    const previousSessionIds = [...input.previous.activeSessionIds].sort(
        compareRtcTopologyIdentifiers
    );
    for (const sessionId of previousSessionIds) {
        graph.addNode(sessionId, {
            id: sessionId,
            type: VertexType.CLIENT,
            state: VertexState.MEMBER,
            degreeLimit: input.degreeLimit
        });
    }

    for (const from of previousSessionIds) {
        for (const to of input.previous.nextHopsBySessionId[from] ?? []) {
            if (from === to || !graph.hasNode(to) || graph.hasEdge(from, to)) {
                continue;
            }
            graph.addEdge(from, to, {
                from,
                to,
                weight: readGlobalEdgeWeight(input.globalGraph, from, to) ??
                    computeCanonicalTopologyPairWeight(from, to)
            });
        }
    }

    return graph;
}

function readGlobalEdgeWeight(
    globalGraph: WeightedGraph,
    from: string,
    to: string
): number | undefined {
    if (!globalGraph.hasNode(from) || !globalGraph.hasNode(to)) {
        return undefined;
    }
    const edgeKey = globalGraph.edge(from, to);
    if (edgeKey === undefined) {
        return undefined;
    }
    return globalGraph.getEdgeAttribute(edgeKey, 'weight') as number;
}
