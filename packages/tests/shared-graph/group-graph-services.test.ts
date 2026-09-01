import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import { readGroupGraphDiagnostic, readScopedGlobalGraphDiagnostic } from '@shared-graph/graph-diagnostics-service.ts';
import {
    computeGlobalGraphAndCacheIt,
    computeGroupGraph,
    computeScopedGlobalGraphAndCacheIt,
    GLOBAL_GRAPH_REF
} from '@shared-graph/group-graphs-create-service.ts';
import { findGraphByRef } from '@shared-graph/repository/graphs-repository.ts';
import { clearAllNodes, hasNode } from '@shared-graph/repository/vivaldi-repository.ts';
import { observeRtt } from '@shared-graph/vivaldi-service.ts';
import type { ClientSession, ClientSnapshot } from '@shared/api/client-types.ts';
import type {
    AuditStamp,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import { setClientStateSnapshotByPrincipalId } from '@shared/repository/client-state-snapshots-repository.ts';
import { setGroupStateSnapshot } from '@shared/repository/group-state-snapshots-repository.ts';
import { latestRttById, setRtt } from '@shared/repository/rtt-repository.ts';
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';
import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';
import { createTestGroup } from '../create-test-group.ts';
import { createRtt } from './helpers.ts';

describe('shared-graph group graph services', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        clearAllNodes();
        latestRttById().clearAll();
    });

    it('returns a left value when the requested group does not exist', () => {
        const result = computeGroupGraph({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId: 'missing-group'
        });

        expect(result.left).toBe('Group not found: missing-group');
        expect(result.right).toBeUndefined();
    });

    it('computes a predicted and measured group graph from repositories', () => {
        const group = createGroupStateSnapshot('group-1', ['peer-a', 'peer-b', 'peer-c']);
        setGroupStateSnapshot(group);

        const pairwiseRtt = [
            createRtt('peer-a', 'peer-b', 10, 1),
            createRtt('peer-a', 'peer-c', 20, 2),
            createRtt('peer-b', 'peer-c', 15, 3)
        ];

        for (const rtt of pairwiseRtt) {
            setRtt(rtt);
            observeRtt(rtt);
        }

        const result = computeGroupGraph(group.group, true);

        expect(result.left).toBeUndefined();
        expect(result.right?.groupRef).toEqual(group.group);
        expect(result.right?.predicted.graph.order).toBe(3);
        expect(result.right?.predicted.groupGraph.order).toBeGreaterThan(0);
        expect(result.right?.predicted.coreNodes.length).toBeGreaterThan(0);
        expect(result.right?.measured?.graph.order).toBe(3);
        expect(result.right?.measured?.groupGraph.order).toBeGreaterThan(0);
        expect(hasNode('peer-a')).toBe(true);
        expect(hasNode('peer-b')).toBe(true);
        expect(hasNode('peer-c')).toBe(true);
    });

    it('computes and caches the global graph using online clients only', () => {
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a'])
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b'])
        );
        setClientStateSnapshotByPrincipalId(
            'peer-offline',
            createClientStateSnapshot('peer-offline', [])
        );

        const rtt = createRtt('peer-a', 'peer-b', 12, 1);
        setRtt(rtt);
        observeRtt(rtt);

        const snapshot = computeGlobalGraphAndCacheIt();

        expect(snapshot.groupRef).toEqual(GLOBAL_GRAPH_REF);
        expect(snapshot.groupRef.groupId).toBe(DEFAULT_GRAPH_PROP.id);
        expect(snapshot.predicted.graph.hasNode('peer-a')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-b')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-offline')).toBe(false);
        expect(snapshot.measured?.graph.hasEdge('peer-a', 'peer-b')).toBe(true);
        expect(findGraphByRef(GLOBAL_GRAPH_REF)).toBe(snapshot);
    });

    it('computes and caches scoped global graphs by app and workspace', () => {
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a'], {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            })
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b'], {
                applicationId: 'app-1',
                workspaceId: 'workspace-a'
            })
        );
        setClientStateSnapshotByPrincipalId(
            'peer-other-workspace',
            createClientStateSnapshot('peer-other-workspace', ['peer-other-workspace'], {
                applicationId: 'app-1',
                workspaceId: 'workspace-b'
            })
        );
        setClientStateSnapshotByPrincipalId(
            'peer-other-app',
            createClientStateSnapshot('peer-other-app', ['peer-other-app'], {
                applicationId: 'app-2',
                workspaceId: 'workspace-a'
            })
        );
        const rtt = createRtt('peer-a', 'peer-b', 12, 1);
        setRtt(rtt);
        observeRtt(rtt);

        const snapshot = computeScopedGlobalGraphAndCacheIt({
            applicationId: 'app-1',
            workspaceId: 'workspace-a'
        }, true);

        expect(snapshot.groupRef).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: '__global__'
        });
        expect(snapshot.predicted.graph.hasNode('peer-a')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-b')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-other-workspace')).toBe(false);
        expect(snapshot.predicted.graph.hasNode('peer-other-app')).toBe(false);
        expect(findGraphByRef(snapshot.groupRef)).toBe(snapshot);
    });

    it('honors graph diagnostic refresh modes', () => {
        const scope = {
            applicationId: 'app',
            workspaceId: 'ws'
        };
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a'])
        );

        const firstRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'if-missing'
        });

        expect(firstRead.left).toBeUndefined();
        expect(firstRead.right?.cache).toEqual({ hit: false, refreshed: true });
        expect(firstRead.right?.snapshot.groupRef.groupId).toBe('__global__');

        const cachedRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'if-missing'
        });

        expect(cachedRead.left).toBeUndefined();
        expect(cachedRead.right?.cache).toEqual({ hit: true, refreshed: false });

        const refreshedRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'always'
        });

        expect(refreshedRead.left).toBeUndefined();
        expect(refreshedRead.right?.cache).toEqual({ hit: true, refreshed: true });

        const missingGroupRead = readGroupGraphDiagnostic({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId: 'missing-group'
        }, {
            includeMeasured: false,
            refresh: 'never'
        });

        expect(missingGroupRead.right).toBeUndefined();
        expect(missingGroupRead.left).toContain('No cached graph diagnostic');
    });

    it('tolerates partial measured RTT coverage when caching the global graph', () => {
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a'])
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b'])
        );
        setClientStateSnapshotByPrincipalId(
            'peer-c',
            createClientStateSnapshot('peer-c', ['peer-c'])
        );

        const rtt = createRtt('peer-a', 'peer-b', 12, 1);
        setRtt(rtt);
        observeRtt(rtt);

        const snapshot = computeGlobalGraphAndCacheIt();

        expect(snapshot.predicted.graph.hasNode('peer-a')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-b')).toBe(true);
        expect(snapshot.predicted.graph.hasNode('peer-c')).toBe(false);
        expect(snapshot.predicted.groupGraph.nodes().sort()).toEqual([
            'peer-a',
            'peer-b'
        ]);
        expect(snapshot.measured?.graph.hasNode('peer-a')).toBe(true);
        expect(snapshot.measured?.graph.hasNode('peer-b')).toBe(true);
        expect(snapshot.measured?.graph.hasNode('peer-c')).toBe(false);
        expect(snapshot.measured?.groupGraph.nodes().sort()).toEqual([
            'peer-a',
            'peer-b'
        ]);
        expect(findGraphByRef(GLOBAL_GRAPH_REF)).toBe(snapshot);
    });
});

function createClientStateSnapshot(
    principalId: string,
    sessionIds: readonly string[],
    scope: Readonly<{ applicationId: string; workspaceId: string; }> = {
        applicationId: 'app',
        workspaceId: 'ws'
    }
): ClientSnapshot {
    const activeSessions = sessionIds.map((sessionId): ClientSession => ({
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        principalId,
        clientInstanceId: principalId,
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));

    return {
        stateRevision: 1,
        principal: {
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            disabled: null,
            deleted: null,
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: createAuditStamp(1, principalId),
            updated: createAuditStamp(1, principalId),
            lastSeenAtEpochMs: activeSessions.length > 0 ? 1 : null
        },
        instances: [],
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs: activeSessions.length > 0 ? 1 : null
    };
}

function createGroupStateSnapshot(
    groupId: string,
    sessionIds: readonly string[]
): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }
    const activeSessions = createGroupSessions(groupId, sessionIds);

    return {
        causalRevision: { groupRevision: 3, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId,
            slug: groupId,
            displayName: groupId,
            joinMode: 'invite-only',
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
            snapshotVersion: 3,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(1, ownerPrincipalId)
        }),
        members: sessionIds.map((principalId, index): GroupMember => ({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId,
            principalId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(1, ownerPrincipalId),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions,
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function createAuditStamp(atEpochMs: number, principalId: string): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId: null
    };
}
function createGroupSessions(groupId: string, sessionIds: readonly string[]): GroupSnapshot['activeSessions'] {
    return sessionIds.map((sessionId): GroupPresenceSession => ({
        applicationId: 'app',
        workspaceId: 'ws',
        groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}
