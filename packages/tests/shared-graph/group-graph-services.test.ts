import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_PROP } from '@shared-graph/algo-props.ts';
import {
    computeScopedGlobalGraphAndCacheIt,
    computeGlobalGraphAndCacheIt,
    computeGroupGraph,
    GLOBAL_GRAPH_REF,
} from '@shared-graph/group-graphs-create-service.ts';
import {
    readGroupGraphDiagnostic,
    readScopedGlobalGraphDiagnostic,
} from '@shared-graph/graph-diagnostics-service.ts';
import { clearAllNodes, hasNode } from '@shared-graph/repository/vivaldi-repository.ts';
import { findGraphByRef, readableGraphCache } from '@shared-graph/repository/graphs-repository.ts';
import { observeRtt } from '@shared-graph/vivaldi-service.ts';
import {
    readableGroupStateSnapshotCache,
    setGroupStateSnapshot,
} from '@shared/repository/group-state-snapshots-repository.ts';
import {
    readableClientStateSnapshotCache,
    setClientStateSnapshotByPrincipalId,
} from '@shared/repository/client-state-snapshots-repository.ts';
import { latestRttById, setRtt } from '@shared/repository/rtt-repository.ts';
import { createRtt } from './helpers.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';

describe('shared-graph group graph services', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        clearAllNodes();
        latestRttById().clearAll();
        (readableGraphCache() as unknown as { clearAll: () => void }).clearAll();
        (readableGroupStateSnapshotCache() as unknown as { clearAll: () => void }).clearAll();
        (readableClientStateSnapshotCache() as unknown as { clearAll: () => void }).clearAll();
    });

    it('returns a left value when the requested group does not exist', () => {
        const result = computeGroupGraph({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId: 'missing-group',
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
            createRtt('peer-b', 'peer-c', 15, 3),
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
            createClientStateSnapshot('peer-a', ['peer-a']),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b']),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-offline',
            createClientStateSnapshot('peer-offline', []),
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
                workspaceId: 'workspace-a',
            }),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b'], {
                applicationId: 'app-1',
                workspaceId: 'workspace-a',
            }),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-other-workspace',
            createClientStateSnapshot('peer-other-workspace', ['peer-other-workspace'], {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
            }),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-other-app',
            createClientStateSnapshot('peer-other-app', ['peer-other-app'], {
                applicationId: 'app-2',
                workspaceId: 'workspace-a',
            }),
        );
        const rtt = createRtt('peer-a', 'peer-b', 12, 1);
        setRtt(rtt);
        observeRtt(rtt);

        const snapshot = computeScopedGlobalGraphAndCacheIt({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
        }, true);

        expect(snapshot.groupRef).toEqual({
            applicationId: 'app-1',
            workspaceId: 'workspace-a',
            groupId: '__global__',
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
            workspaceId: 'ws',
        };
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a']),
        );

        const firstRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'if-missing',
        });

        expect(firstRead.left).toBeUndefined();
        expect(firstRead.right?.cache).toEqual({ hit: false, refreshed: true });
        expect(firstRead.right?.snapshot.groupRef.groupId).toBe('__global__');

        const cachedRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'if-missing',
        });

        expect(cachedRead.left).toBeUndefined();
        expect(cachedRead.right?.cache).toEqual({ hit: true, refreshed: false });

        const refreshedRead = readScopedGlobalGraphDiagnostic(scope, {
            includeMeasured: false,
            refresh: 'always',
        });

        expect(refreshedRead.left).toBeUndefined();
        expect(refreshedRead.right?.cache).toEqual({ hit: true, refreshed: true });

        const missingGroupRead = readGroupGraphDiagnostic({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId: 'missing-group',
        }, {
            includeMeasured: false,
            refresh: 'never',
        });

        expect(missingGroupRead.right).toBeUndefined();
        expect(missingGroupRead.left).toContain('No cached graph diagnostic');
    });

    it('tolerates partial measured RTT coverage when caching the global graph', () => {
        setClientStateSnapshotByPrincipalId(
            'peer-a',
            createClientStateSnapshot('peer-a', ['peer-a']),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-b',
            createClientStateSnapshot('peer-b', ['peer-b']),
        );
        setClientStateSnapshotByPrincipalId(
            'peer-c',
            createClientStateSnapshot('peer-c', ['peer-c']),
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
            'peer-b',
        ]);
        expect(snapshot.measured?.graph.hasNode('peer-a')).toBe(true);
        expect(snapshot.measured?.graph.hasNode('peer-b')).toBe(true);
        expect(snapshot.measured?.graph.hasNode('peer-c')).toBe(false);
        expect(snapshot.measured?.groupGraph.nodes().sort()).toEqual([
            'peer-a',
            'peer-b',
        ]);
        expect(findGraphByRef(GLOBAL_GRAPH_REF)).toBe(snapshot);
    });
});

function createClientStateSnapshot(
    principalId: string,
    sessionIds: readonly string[],
    scope: Readonly<{ applicationId: string; workspaceId: string }> = {
        applicationId: 'app',
        workspaceId: 'ws',
    },
): ClientSnapshot {
    const activeSessions = sessionIds.map((sessionId) => ({
        applicationId: scope.applicationId,
        workspaceId: scope.workspaceId,
        principalId,
        clientInstanceId: principalId,
        sessionId,
        status: 'active' as const,
        presenceState: 'online' as const,
        transport: 'ws' as const,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1000,
    }));

    return {
        principal: {
            applicationId: scope.applicationId,
            workspaceId: scope.workspaceId,
            principalId,
            username: principalId,
            displayName: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: 1,
            },
        },
        instances: [],
        activeSessions,
        isOnline: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        lastSeenAtEpochMs: activeSessions.length > 0 ? 1 : undefined,
    };
}

function createGroupStateSnapshot(
    groupId: string,
    sessionIds: readonly string[],
): GroupSnapshot {
    const activeSessions = sessionIds.map((sessionId) => ({
        applicationId: 'app',
        workspaceId: 'ws',
        groupId,
        sessionId,
        principalId: sessionId,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 1000,
    }));

    return {
        group: {
            applicationId: 'app',
            workspaceId: 'ws',
            groupId,
            displayName: groupId,
            kind: 'room',
            status: 'active',
            joinMode: 'invite-only',
            metadata: {},
            snapshotVersion: 3,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
            updated: {
                atEpochMs: 1,
                byPrincipalId: 'owner',
            },
        },
        members: sessionIds.map((principalId, index) => ({
            applicationId: 'app',
            workspaceId: 'ws',
            groupId,
            principalId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: 1,
            },
        })),
        activeSessions,
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}
