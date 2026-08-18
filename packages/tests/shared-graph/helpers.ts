import { UndirectedGraph } from 'graphology';
import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    type EdgeProp,
    type GraphProp,
    type VertexProp,
    VertexState,
    VertexType,
    type WeightedGraph,
} from '@shared-graph/graph/graph-props.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

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
    const ownerPrincipalId = memberSessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }

    return {
        stateRevision: membershipVersion,
        causalRevision: {
            groupRevision: membershipVersion,
            presenceRevision: membershipVersion,
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            slug: groupId,
            displayName: groupId,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(membershipVersion, ownerPrincipalId),
        }),
        members: memberSessionIds.map((sessionId): GroupMember => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(membershipVersion, ownerPrincipalId),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
        })),
        activeSessions: memberSessionIds.map((sessionId): GroupPresenceSession => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${sessionId}`,
            generationVersion: membershipVersion,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: membershipVersion,
            expiresAtEpochMs: membershipVersion + 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length,
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null,
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
