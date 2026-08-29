import { adoptOverlayTopology } from '@shared-web/browser/state-cache/overlay-topology-message-dispatch.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findAcceptedOverlayById, findPlannedOverlayById, setAcceptedOverlayById, setPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
import { acceptGroupSnapshotUpdate } from '@shared/services/group-snapshot-rtc-sync.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { configureTestCacheRepositories } from '../../cache-repository-config.ts';
import { createTestGroup } from '../../create-test-group.ts';

describe('browser overlay topology role adoption', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('promotes a publication-first planned layout when the group snapshot accepts its full identity', async () => {
        const initialGroup = groupSnapshot(1);
        const topology = topologySnapshot(initialGroup, { groupRevision: 2, presenceRevision: 2 }, 3);
        const manager = webRtcGroupManager();
        groupStateSnapshotsRepository.setGroupStateSnapshot(initialGroup);

        const publication = await adoptOverlayTopology({
            topology,
            sessionId: 'session-a',
            webRtcGroupManager: manager as never,
            adoption: 'publication'
        });

        expect(publication).toMatchObject({ role: 'planned', changed: true });
        expect(findPlannedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);
        expect(findAcceptedOverlayById(topology.overlayId)).toBeUndefined();

        const acceptedGroup = groupSnapshot(2, toGroupLayoutIdentity(topology));
        groupStateSnapshotsRepository.setGroupStateSnapshot(acceptedGroup);
        await acceptGroupSnapshotUpdate(
            acceptedGroup,
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        expect(findPlannedOverlayById(topology.overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);
    });

    it('writes a group-snapshot-first publication directly to accepted', async () => {
        const group = groupSnapshot(2);
        const topology = topologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 3);
        const acceptedGroup = groupSnapshot(2, toGroupLayoutIdentity(topology));
        const manager = webRtcGroupManager();
        groupStateSnapshotsRepository.setGroupStateSnapshot(acceptedGroup);
        await acceptGroupSnapshotUpdate(
            acceptedGroup,
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        const publication = await adoptOverlayTopology({
            topology,
            sessionId: 'session-a',
            webRtcGroupManager: manager as never,
            adoption: 'publication'
        });

        expect(publication).toMatchObject({ role: 'accepted', changed: true });
        expect(findAcceptedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);
        expect(findPlannedOverlayById(topology.overlayId)?.provenance).toBe('bootstrap');
    });

    it('does not promote a browser-local bootstrap that only shares the accepted identity tuple', async () => {
        const initialGroup = groupSnapshot(1);
        const manager = webRtcGroupManager();
        await acceptGroupSnapshotUpdate(
            initialGroup,
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        const overlayId = toScopedOverlayId(initialGroup.group);
        await acceptGroupSnapshotUpdate(
            groupSnapshot(1, {
                groupRevision: 1,
                presenceRevision: 1,
                version: 1,
                state: 'active'
            }),
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        expect(findPlannedOverlayById(overlayId)?.provenance).toBe('bootstrap');
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });

    it('drops superseded and incomparable publications without breaking the handler', async () => {
        const accepted = topologySnapshot(
            groupSnapshot(4),
            { groupRevision: 4, presenceRevision: 4 },
            4
        );
        const acceptedGroup = groupSnapshot(4, toGroupLayoutIdentity(accepted));
        const manager = webRtcGroupManager();
        groupStateSnapshotsRepository.setGroupStateSnapshot(acceptedGroup);

        const superseded = topologySnapshot(
            acceptedGroup,
            { groupRevision: 3, presenceRevision: 3 },
            3
        );
        const incomparable = topologySnapshot(
            acceptedGroup,
            { groupRevision: 5, presenceRevision: 3 },
            5
        );

        await expect(adoptOverlayTopology({
            topology: superseded,
            sessionId: 'session-a',
            webRtcGroupManager: manager as never,
            adoption: 'publication'
        })).resolves.toMatchObject({ role: 'superseded', changed: false });
        await expect(adoptOverlayTopology({
            topology: incomparable,
            sessionId: 'session-a',
            webRtcGroupManager: manager as never,
            adoption: 'publication'
        })).resolves.toMatchObject({ role: 'incomparable', changed: false });
        expect(findPlannedOverlayById(accepted.overlayId)).toBeUndefined();
        expect(manager.notifyOverlayTopologyChanged).not.toHaveBeenCalled();
    });

    it('creates bootstrap only in planned and clears both roles on membership loss', async () => {
        const joined = groupSnapshot(1);
        const manager = webRtcGroupManager();

        await acceptGroupSnapshotUpdate(
            joined,
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        const overlayId = toScopedOverlayId(joined.group);
        expect(findPlannedOverlayById(overlayId)?.provenance).toBe('bootstrap');
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
        setAcceptedOverlayById(overlayId, topologyOverlay(joined, ['session-b'], 2));
        setPlannedOverlayById(overlayId, topologyOverlay(joined, ['session-c'], 3));

        await acceptGroupSnapshotUpdate(
            groupSnapshot(2, undefined, ['session-b', 'session-c']),
            manager as never,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });
});

function webRtcGroupManager() {
    return {
        notifyOverlayTopologyChanged: vi.fn(async () => undefined),
        acceptGroupUpdate: vi.fn(async () => undefined),
        ensureAllGroupsConnected: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        has: vi.fn(() => true)
    };
}

function groupSnapshot(
    version: number,
    acceptedLayoutIdentity?: ReturnType<typeof toGroupLayoutIdentity>,
    sessionIds: readonly string[] = ['session-a', 'session-b', 'session-c']
): GroupSnapshot {
    return {
        causalRevision: { groupRevision: version, presenceRevision: version },
        group: createTestGroup({
            groupId: 'group-1',
            snapshotVersion: version,
            rosterVersion: version,
            presenceVersion: version,
            acceptedLayoutIdentity: acceptedLayoutIdentity ?? null
        }),
        members: [],
        activeSessions: sessionIds.map(activeSession),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function activeSession(sessionId: string): GroupSnapshot['activeSessions'][number] {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId: sessionId,
        sessionId,
        generationId: 'generation-1',
        generationVersion: 1,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1,
        expiresAtEpochMs: 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function topologySnapshot(
    group: GroupSnapshot,
    causalRevision: GroupStateCausalRevision,
    version: number
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        name: group.group.displayName,
        topology: 'tree',
        activeSessionIds: group.activeSessions.map((session) => session.sessionId),
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

function topologyOverlay(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    version: number
) {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: version,
            presenceRevision: version
        },
        provenance: 'server' as const,
        state: 'active' as const,
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree' as const,
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [...nextHopSessionIds],
        degreeLimit: 5,
        overlayVersion: version,
        updatedAtEpochMs: version
    };
}
