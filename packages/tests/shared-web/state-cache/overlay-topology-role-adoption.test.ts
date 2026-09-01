import { adoptOverlayTopology } from '@shared-web/browser/state-cache/overlay-topology-message-dispatch.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { toOverlayInfoForSession, type RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    resetOverlayAdoptionDiagnostics,
    setAcceptedOverlayById,
    setOverlayAdoptionDiagnosticsSink,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';
import {
    acceptGroupSnapshotRemoval,
    acceptGroupSnapshotUpdate,
    type GroupSnapshotRtcSyncPort
} from '@shared/services/group-snapshot-rtc-sync.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createTestGroup } from '../../create-test-group.ts';

describe('browser overlay topology role adoption', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        resetOverlayAdoptionDiagnostics();
        setOverlayAdoptionDiagnosticsSink(undefined);
    });

    it('allows a planned publication before the group has ever been observed', async () => {
        const group = groupSnapshot(1);
        const topology = topologySnapshot(
            group,
            { groupRevision: 2, presenceRevision: 2 },
            2
        );

        await expect(adoptOverlayTopology({
            topology,
            sessionId: 'session-a',
            webRtcGroupManager: webRtcGroupManager(),
            adoption: 'publication'
        })).resolves.toMatchObject({
            role: 'planned',
            changed: true
        });
        expect(findPlannedOverlayById(topology.overlayId)?.overlayVersion).toBe(2);
    });

    it.each(['publication', 'current-state'] as const)(
        'retires a producer-shaped same-tuple plan through %s and rejects its delayed active copy',
        async (adoption) => {
            const group = groupSnapshot(1);
            const active = topologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 2);
            const removed: RallarOverlayTopologySnapshot = {
                ...active,
                state: 'removed',
                nextHopsBySessionId: { 'session-a': [], 'session-b': [] }
            };
            const manager = webRtcGroupManager();
            groupStateSnapshotsRepository.setGroupStateSnapshot(group);
            for (const topology of [active, removed]) {
                await expect(adoptOverlayTopology({
                    topology,
                    sessionId: 'session-a',
                    webRtcGroupManager: manager,
                    adoption
                })).resolves.toMatchObject({ role: 'planned', changed: true });
            }
            expect(findPlannedOverlayById(active.overlayId)).toBeUndefined();
            await expect(adoptOverlayTopology({
                topology: active,
                sessionId: 'session-a',
                webRtcGroupManager: manager,
                adoption
            })).resolves.toMatchObject({ outcome: 'dominated-dropped', changed: false });
            expect(findPlannedOverlayById(active.overlayId)).toBeUndefined();
        }
    );

    it('promotes a publication-first planned layout when the group snapshot accepts its full identity', async () => {
        const initialGroup = groupSnapshot(1);
        const topology = topologySnapshot(initialGroup, { groupRevision: 2, presenceRevision: 2 }, 3);
        const manager = webRtcGroupManager();
        groupStateSnapshotsRepository.setGroupStateSnapshot(initialGroup);

        const publication = await adoptOverlayTopology({
            topology,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            adoption: 'publication'
        });

        expect(publication).toMatchObject({ role: 'planned', changed: true });
        expect(findPlannedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);
        expect(findAcceptedOverlayById(topology.overlayId)).toBeUndefined();

        const acceptedGroup = groupSnapshot(2, toGroupLayoutIdentity(topology));
        groupStateSnapshotsRepository.setGroupStateSnapshot(acceptedGroup);
        await acceptGroupSnapshotUpdate(
            acceptedGroup,
            manager,
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
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        const publication = await adoptOverlayTopology({
            topology,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
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
            manager,
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
            manager,
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
            webRtcGroupManager: manager,
            adoption: 'publication'
        })).resolves.toMatchObject({ role: 'superseded', changed: false });
        await expect(adoptOverlayTopology({
            topology: incomparable,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            adoption: 'publication'
        })).resolves.toMatchObject({ role: 'incomparable', changed: false });
        expect(findPlannedOverlayById(accepted.overlayId)).toBeUndefined();
    });

    it('creates bootstrap only in planned and clears both roles on membership loss', async () => {
        const joined = groupSnapshot(1);
        const manager = webRtcGroupManager();

        await acceptGroupSnapshotUpdate(
            joined,
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        const overlayId = toScopedOverlayId(joined.group);
        expect(findPlannedOverlayById(overlayId)?.provenance).toBe('bootstrap');
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
        setAcceptedOverlayById(overlayId, topologyOverlay(joined, ['session-b'], 2));
        setPlannedOverlayById(overlayId, topologyOverlay(joined, ['session-c'], 3));

        await acceptGroupSnapshotUpdate(
            groupSnapshot(2, undefined, ['session-b', 'session-c']),
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });

    it('replaces stale accepted A with server-planned B when the group accepts B', async () => {
        const groupA = groupSnapshot(1);
        const acceptedA = topologySnapshot(
            groupA,
            { groupRevision: 1, presenceRevision: 1 },
            1
        );
        const groupB = groupSnapshot(2);
        const plannedB = topologySnapshot(
            groupB,
            { groupRevision: 2, presenceRevision: 2 },
            2
        );
        const acceptedGroupB = groupSnapshot(2, toGroupLayoutIdentity(plannedB));
        const overlayId = plannedB.overlayId;
        setAcceptedOverlayById(
            overlayId,
            toOverlayInfoForSession(acceptedA, 'session-a')
        );
        setPlannedOverlayById(
            overlayId,
            toOverlayInfoForSession(plannedB, 'session-a')
        );
        groupStateSnapshotsRepository.setGroupStateSnapshot(acceptedGroupB);

        await acceptGroupSnapshotUpdate(
            acceptedGroupB,
            webRtcGroupManager(),
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        expect(findAcceptedOverlayById(overlayId)).toEqual(
            toOverlayInfoForSession(plannedB, 'session-a')
        );
        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
    });

    it('drops a delayed publication after group removal and admits publication after rejoin', async () => {
        const joined = groupSnapshot(1);
        const delayedTopology = topologySnapshot(
            joined,
            { groupRevision: 2, presenceRevision: 2 },
            2
        );
        const manager = webRtcGroupManager();
        groupStateSnapshotsRepository.setGroupStateSnapshot(joined);
        await acceptGroupSnapshotUpdate(
            joined,
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );
        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(joined.group);
        await acceptGroupSnapshotRemoval(joined, manager);

        await expect(adoptOverlayTopology({
            topology: delayedTopology,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            adoption: 'publication'
        })).resolves.toMatchObject({
            outcome: 'membership-ineligible-dropped',
            changed: false
        });

        expect(findPlannedOverlayById(delayedTopology.overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(delayedTopology.overlayId)).toBeUndefined();

        const rejoined = groupSnapshot(3);
        const currentTopology = topologySnapshot(
            rejoined,
            { groupRevision: 4, presenceRevision: 4 },
            4
        );
        groupStateSnapshotsRepository.setGroupStateSnapshot(rejoined);
        await acceptGroupSnapshotUpdate(
            rejoined,
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        await expect(adoptOverlayTopology({
            topology: currentTopology,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            adoption: 'publication'
        })).resolves.toMatchObject({
            role: 'planned',
            changed: true
        });
        expect(findPlannedOverlayById(currentTopology.overlayId)?.overlayVersion).toBe(4);
    });

    it('drops a delayed publication after membership loss without recreating either role', async () => {
        const joined = groupSnapshot(1);
        const lostMembership = groupSnapshot(2, undefined, ['session-b', 'session-c']);
        const delayedTopology = topologySnapshot(
            joined,
            { groupRevision: 3, presenceRevision: 3 },
            3
        );
        const manager = webRtcGroupManager();
        const adoptionOutcomes: string[] = [];
        setOverlayAdoptionDiagnosticsSink((event) => {
            adoptionOutcomes.push(event.outcome);
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot(joined);
        await acceptGroupSnapshotUpdate(
            joined,
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );
        groupStateSnapshotsRepository.setGroupStateSnapshot(lostMembership);
        await acceptGroupSnapshotUpdate(
            lostMembership,
            manager,
            { localSessionId: 'session-a', bootstrapDegree: 5 }
        );

        await expect(adoptOverlayTopology({
            topology: delayedTopology,
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            adoption: 'publication'
        })).resolves.toMatchObject({
            outcome: 'membership-ineligible-dropped',
            changed: false
        });

        expect(findPlannedOverlayById(delayedTopology.overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(delayedTopology.overlayId)).toBeUndefined();
        expect(adoptionOutcomes).toContain('membership-ineligible-dropped');
    });
});

function webRtcGroupManager(): GroupSnapshotRtcSyncPort & Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'> {
    return {
        notifyOverlayTopologyChanged: async () => undefined,
        acceptGroupUpdate: async () => undefined,
        ensureAllGroupsConnected: async () => undefined,
        delete: async () => false,
        has: () => true
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
): OverlayInfo {
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
