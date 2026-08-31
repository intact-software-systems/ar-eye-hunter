// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { hydrateGroupTopologyOverlays } from '@shared-web/browser/state-read/hydrate-group-topology-overlays.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { AuditStamp, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { toOverlayInfoForSession } from '@shared/api/overlay-topology.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    removeAcceptedOverlayById,
    removePlannedOverlayById,
    setAcceptedOverlayById,
    setPlannedOverlayById
} from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';
import { createTestGroup } from '../create-test-group.ts';

const scope: StateScope = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID
};

describe('group topology read-through', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('adopts the current server overlay for each joined group', async () => {
        const group = createGroupSnapshot('room-a', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const topology = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 3);
        const requestedUrls: string[] = [];
        vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
            requestedUrls.push(String(input));
            return jsonResponse(topologyView(group, topology));
        });
        let topologyChangeNotified = false;
        const manager = createWebRtcGroupManager(() => {
            topologyChangeNotified = true;
        });

        const outcomes = await hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });

        expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'adopted' }]);
        expect(requestedUrls).toEqual([expect.stringContaining('/groups/room-a/topology')]);
        const overlay = findPlannedOverlayById(topology.overlayId);
        expect(overlay?.provenance).toBe('server');
        expect(overlay?.overlayVersion).toBe(3);
        expect(topologyChangeNotified).toBe(true);
    });

    it('skips groups the session has not joined and reports absent overlays', async () => {
        const joined = createGroupSnapshot('room-a', ['session-a']);
        const notJoined = createGroupSnapshot('room-b', ['session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshots([joined, notJoined]);
        const requestedUrls: string[] = [];
        vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
            requestedUrls.push(String(input));
            return jsonResponse(topologyView(joined, null));
        });

        const outcomes = await hydrateGroupTopologyOverlays({
            groupSnapshots: [joined, notJoined],
            sessionId: 'session-a',
            webRtcGroupManager: createWebRtcGroupManager(),
            scope,
            apiRequest: { authSession: null }
        });

        expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
        expect(requestedUrls).toEqual([expect.stringContaining('/groups/room-a/topology')]);
    });

    it('reports a failed read without breaking the remaining groups', async () => {
        const groupA = createGroupSnapshot('room-a', ['session-a']);
        const groupB = createGroupSnapshot('room-b', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshots([groupA, groupB]);
        const topologyB = createTopologySnapshot(groupB, { groupRevision: 1, presenceRevision: 1 }, 1);
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/groups/room-a/')) {
                throw new Error('network down');
            }
            return jsonResponse(topologyView(groupB, topologyB));
        });
        vi.stubGlobal('fetch', fetchMock);

        const outcomes = await hydrateGroupTopologyOverlays({
            groupSnapshots: [groupA, groupB],
            sessionId: 'session-a',
            webRtcGroupManager: createWebRtcGroupManager(),
            scope,
            apiRequest: { authSession: null }
        });

        expect(outcomes).toEqual([
            { groupId: 'room-a', outcome: 'read-failed' },
            { groupId: 'room-b', outcome: 'adopted' }
        ]);
    });

    it('force-adopts an incomparable server overlay as fresh durable current state', async () => {
        const group = createGroupSnapshot('room-a', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const existing = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 1 }, 5);
        setPlannedOverlayById(existing.overlayId, toOverlayInfoForSession(existing, 'session-a'));
        const incoming = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 2 }, 6);
        const fetchMock = vi.fn(async () => jsonResponse(topologyView(group, incoming)));
        vi.stubGlobal('fetch', fetchMock);

        const outcomes = await hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: createWebRtcGroupManager(),
            scope,
            apiRequest: { authSession: null }
        });

        expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'adopted' }]);
        expect(findPlannedOverlayById(incoming.overlayId)?.overlayVersion).toBe(6);
    });

    it('hydrates and clears the planned and accepted current-state fields independently', async () => {
        const group = createGroupSnapshot('room-a', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const planned = createTopologySnapshot(group, { groupRevision: 3, presenceRevision: 3 }, 4);
        const accepted = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 3);
        const responses = [
            topologyView(group, planned, accepted),
            topologyView(group, null, null)
        ];
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(responses.shift())));
        const manager = createWebRtcGroupManager();

        await hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });

        expect(findPlannedOverlayById(planned.overlayId)?.overlayVersion).toBe(4);
        expect(findAcceptedOverlayById(accepted.overlayId)?.overlayVersion).toBe(3);

        const cleared = await hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });

        expect(cleared).toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
        expect(findPlannedOverlayById(planned.overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(accepted.overlayId)).toBeUndefined();
    });

    it('hydrates same-tuple tombstones into both roles without reviving a delayed active copy', async () => {
        const group = createGroupSnapshot('room-a', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const active = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 3);
        const removed: RallarOverlayTopologySnapshot = {
            ...active,
            state: 'removed',
            nextHopsBySessionId: { 'session-a': [] }
        };
        const responses = [active, removed, active];
        vi.stubGlobal('fetch', async () => {
            const snapshot = responses.shift()!;
            return jsonResponse(topologyView(group, snapshot, snapshot));
        });
        const input = {
            groupSnapshots: [group],
            sessionId: 'session-a',
            scope,
            webRtcGroupManager: createWebRtcGroupManager(),
            apiRequest: { authSession: null }
        };
        await hydrateGroupTopologyOverlays(input);
        expect(findPlannedOverlayById(active.overlayId)?.state).toBe('active');
        expect(findAcceptedOverlayById(active.overlayId)?.state).toBe('active');
        for (const delivery of ['retirement', 'delayed active']) {
            expect(await hydrateGroupTopologyOverlays(input), delivery)
                .toEqual([{ groupId: 'room-a', outcome: 'adopted' }]);
            expect(findPlannedOverlayById(active.overlayId)).toBeUndefined();
            expect(findAcceptedOverlayById(active.overlayId)).toBeUndefined();
        }
    });

    it('preserves newer planned and accepted publications that arrive while a null read is pending', async () => {
        const group = createGroupSnapshot('room-a', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        const oldPlanned = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        const oldAccepted = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        setPlannedOverlayById(overlayId, toOverlayInfoForSession(oldPlanned, 'session-a'));
        setAcceptedOverlayById(overlayId, toOverlayInfoForSession(oldAccepted, 'session-a'));
        const response = Promise.withResolvers<Response>();
        const requestStarted = Promise.withResolvers<void>();
        vi.stubGlobal('fetch', () => {
            requestStarted.resolve();
            return response.promise;
        });
        const manager = createWebRtcGroupManager();

        const hydration = hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });
        await requestStarted.promise;

        const newerPlanned = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 2);
        const newerAccepted = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 2);
        setPlannedOverlayById(overlayId, toOverlayInfoForSession(newerPlanned, 'session-a'));
        setAcceptedOverlayById(overlayId, toOverlayInfoForSession(newerAccepted, 'session-a'));
        response.resolve(jsonResponse(topologyView(group, null, null)));

        await expect(hydration).resolves.toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
        expect(findPlannedOverlayById(overlayId)?.overlayVersion).toBe(2);
        expect(findAcceptedOverlayById(overlayId)?.overlayVersion).toBe(2);
    });

    it('clears unchanged planned and accepted observations when a null read completes', async () => {
        const group = createGroupSnapshot('room-a', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        const planned = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        const accepted = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        setPlannedOverlayById(overlayId, toOverlayInfoForSession(planned, 'session-a'));
        setAcceptedOverlayById(overlayId, toOverlayInfoForSession(accepted, 'session-a'));
        const response = Promise.withResolvers<Response>();
        const requestStarted = Promise.withResolvers<void>();
        vi.stubGlobal('fetch', () => {
            requestStarted.resolve();
            return response.promise;
        });
        let topologyChangeNotified = false;
        const manager = createWebRtcGroupManager(() => {
            topologyChangeNotified = true;
        });

        const hydration = hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });
        await requestStarted.promise;
        response.resolve(jsonResponse(topologyView(group, null, null)));

        await expect(hydration).resolves.toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
        expect(topologyChangeNotified).toBe(true);
    });

    it('does not resurrect overlay roles after membership is removed while a topology read is pending', async () => {
        const group = createGroupSnapshot('room-a', ['session-a', 'session-b']);
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const overlayId = toScopedOverlayId(group.group);
        const initial = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        setPlannedOverlayById(overlayId, toOverlayInfoForSession(initial, 'session-a'));
        setAcceptedOverlayById(overlayId, toOverlayInfoForSession(initial, 'session-a'));
        const planned = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 2 }, 2);
        const accepted = createTopologySnapshot(group, { groupRevision: 1, presenceRevision: 1 }, 1);
        const response = Promise.withResolvers<Response>();
        const requestStarted = Promise.withResolvers<void>();
        vi.stubGlobal('fetch', () => {
            requestStarted.resolve();
            return response.promise;
        });
        const manager = createWebRtcGroupManager();

        const hydration = hydrateGroupTopologyOverlays({
            groupSnapshots: [group],
            sessionId: 'session-a',
            webRtcGroupManager: manager,
            scope,
            apiRequest: { authSession: null }
        });
        await requestStarted.promise;

        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(group.group);
        removeOverlayRoles(overlayId);
        response.resolve(jsonResponse(topologyView(group, planned, accepted)));

        await expect(hydration).resolves.toEqual([{ groupId: 'room-a', outcome: 'no-overlay' }]);
        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });

    it('rejects topology views whose outer group or overlay id differs from the requested group', async () => {
        const groupA = createGroupSnapshot('room-a', ['session-a']);
        const groupB = createGroupSnapshot('room-b', ['session-a']);
        groupStateSnapshotsRepository.setGroupStateSnapshots([groupA, groupB]);
        const wrongGroupRef = {
            ...groupB.group,
            groupId: 'other-room'
        };
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            if (String(input).includes('/groups/room-a/')) {
                return jsonResponse({
                    ...topologyView(groupA, null, null) as object,
                    overlayId: 'not-the-canonical-overlay-id'
                });
            }
            return jsonResponse({
                ...topologyView(groupB, null, null) as object,
                groupRef: wrongGroupRef,
                overlayId: toScopedOverlayId(wrongGroupRef)
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        const outcomes = await hydrateGroupTopologyOverlays({
            groupSnapshots: [groupA, groupB],
            sessionId: 'session-a',
            webRtcGroupManager: createWebRtcGroupManager(),
            scope,
            apiRequest: { authSession: null }
        });

        expect(outcomes).toEqual([
            { groupId: 'room-a', outcome: 'read-failed' },
            { groupId: 'room-b', outcome: 'read-failed' }
        ]);
    });

    it.each(['snapshot', 'acceptedSnapshot'] as const)(
        'rejects a %s whose canonical group and key differ from the outer topology view',
        async (role) => {
            const requestedGroup = createGroupSnapshot('room-a', ['session-a']);
            const otherGroup = createGroupSnapshot('room-b', ['session-a']);
            groupStateSnapshotsRepository.setGroupStateSnapshot(requestedGroup);
            const wrongSnapshot = createTopologySnapshot(
                otherGroup,
                { groupRevision: 1, presenceRevision: 1 },
                1
            );
            const view = {
                ...topologyView(requestedGroup, null, null) as object,
                [role]: wrongSnapshot
            };
            vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(view)));

            const outcomes = await hydrateGroupTopologyOverlays({
                groupSnapshots: [requestedGroup],
                sessionId: 'session-a',
                webRtcGroupManager: createWebRtcGroupManager(),
                scope,
                apiRequest: { authSession: null }
            });

            expect(outcomes).toEqual([{ groupId: 'room-a', outcome: 'read-failed' }]);
            expect(findPlannedOverlayById(toScopedOverlayId(requestedGroup.group))).toBeUndefined();
            expect(findAcceptedOverlayById(toScopedOverlayId(requestedGroup.group))).toBeUndefined();
        }
    );
});

function removeOverlayRoles(overlayId: string): void {
    removePlannedOverlayById(overlayId);
    removeAcceptedOverlayById(overlayId);
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function topologyView(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot | null,
    acceptedSnapshot: RallarOverlayTopologySnapshot | null = null
): unknown {
    return {
        groupRef: {
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId,
            groupId: group.group.groupId
        },
        overlayId: toScopedOverlayId(group.group),
        snapshot,
        acceptedSnapshot,
        config: null,
        pending: null
    };
}

function createWebRtcGroupManager(onTopologyChanged?: () => void): WebRtcGroupManager {
    return {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
        notifyOverlayTopologyChanged: async () => {
            onTopologyChanged?.();
        },
        acceptGroupUpdate: vi.fn(async () => undefined),
        ensureAllGroupsConnected: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        has: vi.fn(() => false)
    } as never;
}

function createGroupSnapshot(groupId: string, sessionIds: readonly string[]): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0] ?? 'owner';
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        group: createTestGroup({
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            groupId,
            displayName: groupId,
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 1,
            created: auditStamp(1),
            updated: auditStamp(1),
            activeMemberCount: sessionIds.length,
            ownerPrincipalId
        }),
        members: sessionIds.map((sessionId) => ({
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: auditStamp(1),
            updated: auditStamp(1),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: 'generation-1',
            generationVersion: 1,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: Date.now() + 120_000
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length
    };
}

function createTopologySnapshot(
    group: GroupSnapshot,
    causalRevision: GroupSnapshot['causalRevision'],
    version: number
): RallarOverlayTopologySnapshot {
    const activeSessionIds = group.activeSessions
        .map((session) => session.sessionId)
        .toSorted();
    const nextHopsBySessionId = Object.fromEntries(
        activeSessionIds.map((sessionId, index) => [
            sessionId,
            [activeSessionIds[index - 1], activeSessionIds[index + 1]]
                .filter((peerId): peerId is string => peerId !== undefined)
                .toSorted()
        ])
    );
    return {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: {
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId,
            groupId: group.group.groupId
        },
        name: group.group.displayName,
        topology: 'tree',
        activeSessionIds,
        nextHopsBySessionId,
        degreeLimit: 5,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

function auditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId: 'test' },
        reason: null,
        traceId: null,
        requestId: null
    };
}
