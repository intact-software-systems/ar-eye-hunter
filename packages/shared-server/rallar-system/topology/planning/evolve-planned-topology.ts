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
import { computeNoRttTopologyNextHops } from './compute-no-rtt-topology-next-hops.ts';

export interface EvolvePlannedTopologyInput {
    readonly previous: RallarOverlayTopologySnapshot;
    readonly group: GroupSnapshot;
    readonly leaderSessionId: string | undefined;
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
    | 'leader-rooting'
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
    const delta = computeTopologyMembershipDelta(input);
    const rebuildReason = resolveEvolveFullRebuildReason(input, delta);
    if (rebuildReason !== undefined) {
        return { outcome: 'full-rebuild', reason: rebuildReason };
    }

    const evolved = computeEvolvedGraph(input, delta);
    if (evolved === undefined) {
        return { outcome: 'full-rebuild', reason: 'update-failed' };
    }

    const validation = validateGroupTopology({
        graph: evolved,
        activeSessionIds: new Set(input.activeSessionIds),
        maxDegree: input.degreeLimit
    });
    if (!validation.valid) {
        return { outcome: 'full-rebuild', reason: 'invariant-violation' };
    }

    return { outcome: 'planned', nextHopsBySessionId: toNextHopsBySessionId(evolved, input.activeSessionIds) };
}

interface TopologyMembershipDelta {
    readonly addedSessionIds: readonly string[];
    readonly removedSessionIds: readonly string[];
}

interface LeaderBreadthFirstJoinsInput {
    readonly evolve: EvolvePlannedTopologyInput;
    readonly graph: WeightedGraph;
    readonly leaderSessionId: string;
    readonly joinedSessionIds: readonly string[];
}

interface TopologyMembershipChange {
    readonly sessionId: string;
    readonly type: MessageType;
}

function computeTopologyMembershipDelta(input: EvolvePlannedTopologyInput): TopologyMembershipDelta {
    const currentSessionIds = new Set(input.activeSessionIds);
    const previousSessionIds = new Set(input.previous.activeSessionIds);
    return {
        addedSessionIds: input.activeSessionIds.filter((sessionId) => !previousSessionIds.has(sessionId)),
        removedSessionIds: input.previous.activeSessionIds.filter((sessionId) => !currentSessionIds.has(sessionId))
    };
}

/**
 * A tree's next hops are undirected, so a leader whose eccentricity in the
 * previous tree is within the depth of the no-RTT tree rooted at it is
 * re-rooted in place; a snapshot carries no root, so an unchanged leader and
 * a newly appointed one are judged alike.
 */
function resolveEvolveFullRebuildReason(
    input: EvolvePlannedTopologyInput,
    delta: TopologyMembershipDelta
): EvolvePlannedTopologyFullRebuildReason | undefined {
    const deltaSize = delta.addedSessionIds.length + delta.removedSessionIds.length;
    if (input.kind === 'tree' && input.leaderSessionId !== undefined) {
        if (delta.addedSessionIds.includes(input.leaderSessionId)) {
            return 'leader-rooting';
        }
        if (deltaSize === 0 && computeLeaderDepthExcess(input, input.leaderSessionId) > 0) {
            return 'leader-rooting';
        }
    }

    const joinsOnly = input.kind === 'tree' && delta.removedSessionIds.length === 0;
    const deltaBudget = Math.max(2, Math.ceil(input.previous.activeSessionIds.length / 4));
    if (!joinsOnly && deltaSize > deltaBudget) {
        return 'delta-too-large';
    }
    return undefined;
}

function computeLeaderDepthExcess(input: EvolvePlannedTopologyInput, leaderSessionId: string): number {
    const rootedNextHops = computeNoRttTopologyNextHops({
        topology: 'tree',
        activeSessionIds: input.activeSessionIds,
        preferredSourceSessionId: leaderSessionId,
        degreeLimit: input.degreeLimit,
        meshParamK: input.meshParamK
    });
    return computeHopEccentricity(input.previous.nextHopsBySessionId, leaderSessionId) -
        computeHopEccentricity(rootedNextHops, leaderSessionId);
}

function computeHopEccentricity(
    nextHopsBySessionId: Readonly<Record<string, readonly string[]>>,
    sessionId: string
): number {
    return computeHopLevels((current) => nextHopsBySessionId[current] ?? [], sessionId).length - 1;
}

/** Breadth-first levels from the root, each in canonical order, so a level-order scan is deterministic. */
function computeHopLevels(
    neighboursOf: (sessionId: string) => readonly string[],
    rootSessionId: string
): readonly (readonly string[])[] {
    const visited = new Set([rootSessionId]);
    const levels: string[][] = [[rootSessionId]];
    for (let depth = 0; depth < levels.length; depth += 1) {
        const nextLevel = [...new Set((levels[depth] ?? []).flatMap(neighboursOf))]
            .filter((sessionId) => !visited.has(sessionId))
            .sort(compareRtcTopologyIdentifiers);
        nextLevel.forEach((sessionId) => visited.add(sessionId));
        if (nextLevel.length > 0) {
            levels.push(nextLevel);
        }
    }
    return levels;
}

function computeEvolvedGraph(
    input: EvolvePlannedTopologyInput,
    delta: TopologyMembershipDelta
): WeightedGraph | undefined {
    let evolved = reconstructPreviousGraph(input);
    try {
        for (const sessionId of delta.removedSessionIds) {
            evolved = applyMembershipChange(input, evolved, { sessionId, type: MessageType.TO_SERVER_LEAVE });
        }
        if (input.kind === 'tree' && input.leaderSessionId !== undefined) {
            return computeLeaderBreadthFirstJoins({
                evolve: input,
                graph: evolved,
                leaderSessionId: input.leaderSessionId,
                joinedSessionIds: delta.addedSessionIds
            });
        }
        for (const sessionId of delta.addedSessionIds) {
            evolved = applyMembershipChange(input, evolved, { sessionId, type: MessageType.TO_SERVER_ENTER });
        }
    }
    catch {
        return undefined;
    }
    return evolved;
}

/** Attaching each join to the shallowest open session keeps the leader within the no-RTT rooted depth by construction. */
function computeLeaderBreadthFirstJoins(input: LeaderBreadthFirstJoinsInput): WeightedGraph | undefined {
    const { degreeLimit, globalGraph } = input.evolve;
    const joined = input.graph.copy();
    for (const sessionId of input.joinedSessionIds) {
        const parentSessionId = computeHopLevels((current) => joined.neighbors(current), input.leaderSessionId)
            .flat()
            .find((candidate) => joined.degree(candidate) < degreeLimit);
        if (parentSessionId === undefined) {
            return undefined;
        }
        joined.addNode(sessionId, toClientVertex(sessionId, degreeLimit));
        joined.addEdge(parentSessionId, sessionId, toTreeEdge(globalGraph, parentSessionId, sessionId));
    }
    return joined;
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

function toNextHopsBySessionId(
    graph: WeightedGraph,
    activeSessionIds: readonly string[]
): Record<string, readonly string[]> {
    return Object.fromEntries(
        activeSessionIds.map((sessionId) => [
            sessionId,
            graph.hasNode(sessionId) ? (graph.neighbors(sessionId) as string[]).sort() : []
        ])
    );
}

function reconstructPreviousGraph(input: EvolvePlannedTopologyInput): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(input.globalGraph.getAttributes());

    const previousSessionIds = [...input.previous.activeSessionIds].sort(
        compareRtcTopologyIdentifiers
    );
    for (const sessionId of previousSessionIds) {
        graph.addNode(sessionId, toClientVertex(sessionId, input.degreeLimit));
    }

    for (const from of previousSessionIds) {
        for (const to of input.previous.nextHopsBySessionId[from] ?? []) {
            if (from === to || !graph.hasNode(to) || graph.hasEdge(from, to)) {
                continue;
            }
            graph.addEdge(from, to, toTreeEdge(input.globalGraph, from, to));
        }
    }

    return graph;
}

function toClientVertex(sessionId: string, degreeLimit: number): VertexProp {
    return { id: sessionId, type: VertexType.CLIENT, state: VertexState.MEMBER, degreeLimit };
}

function toTreeEdge(globalGraph: WeightedGraph, from: string, to: string): EdgeProp {
    return {
        from,
        to,
        weight: readGlobalEdgeWeight(globalGraph, from, to) ?? computeCanonicalTopologyPairWeight(from, to)
    };
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
