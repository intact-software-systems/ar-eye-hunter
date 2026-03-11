import { UndirectedGraph } from 'graphology';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '@shared-graph/graph/graph-props.ts';

export function createGraph(
    nodes: ReadonlyArray<readonly [string, VertexState, number]>,
    edges: ReadonlyArray<readonly [string, string, number]>,
): WeightedGraph {
    const graph = new UndirectedGraph<VertexProp, EdgeProp, GraphProp>();
    graph.replaceAttributes(DEFAULT_GRAPH_PROP);

    for (const [id, state, degreeLimit] of nodes) {
        graph.addNode(id, {
            id,
            type: VertexType.CLIENT,
            state,
            degreeLimit,
        });
    }

    for (const [from, to, weight] of edges) {
        graph.addEdge(from, to, {
            from,
            to,
            weight,
        });
    }

    return graph as WeightedGraph;
}

export function createGroupSnapshot(
    groupId: string,
    memberSessionIds: readonly string[],
    membershipVersion = 1,
): GroupSnapshot {
    const applicationId = 'app-1';
    const workspaceId = 'workspace-1';

    return {
        group: {
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'owner',
            },
        },
        members: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'owner',
            },
        })),
        activeSessions: memberSessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: membershipVersion,
            expiresAtEpochMs: membershipVersion + 60_000,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

export function createRtt(
    sessionIdFrom: string,
    sessionIdTo: string,
    rttMs: number,
    version: number,
): RttMeasurementInfo {
    return {
        sessionIdFrom,
        sessionIdTo,
        rttMs,
        createdAtEpochMs: version,
        version,
    };
}
