import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupEvent, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import { newALBroadcastMessage, newALEventRoute } from '@shared/al-contracts/al-contract.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findOverlayById } from '@shared/repository/overlays-repository.ts';
import * as dataCaches from '@shared-web/browser/data-caches.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';

describe('browser data caches state scope filtering', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('hydrates only snapshots in the default state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const sameScopeClient = createClientSnapshot(
            'alice',
            'session-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            1,
        );
        const otherWorkspaceClient = createClientSnapshot(
            'bob',
            'session-b',
            DEFAULT_STATE_APPLICATION_ID,
            'workspace-b',
            1,
        );
        const sameScopeGroup = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a'],
            1,
        );
        const otherWorkspaceGroup = createGroupSnapshot(
            'room-b',
            DEFAULT_STATE_APPLICATION_ID,
            'workspace-b',
            ['session-b'],
            1,
        );

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [sameScopeClient, otherWorkspaceClient],
            [sameScopeGroup, otherWorkspaceGroup],
        );

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId)
                .sort(),
        ).toEqual(['alice']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId)
                .sort(),
        ).toEqual(['room-a']);
    });

    it('hydrates only snapshots in an explicit custom state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const defaultScopeClient = createClientSnapshot(
            'alice',
            'session-a',
            'ar-eye-hunter',
            'default',
            1,
        );
        const customScopeClient = createClientSnapshot(
            'bob',
            'session-b',
            'app-1',
            'workspace-b',
            1,
        );
        const defaultScopeGroup = createGroupSnapshot(
            'room-a',
            'ar-eye-hunter',
            'default',
            ['session-a'],
            1,
        );
        const customScopeGroup = createGroupSnapshot(
            'room-b',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [defaultScopeClient, customScopeClient],
            [defaultScopeGroup, customScopeGroup],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId),
        ).toEqual(['bob']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId),
        ).toEqual(['room-b']);
    });

    it('deletes scoped RTC group tracking when the current session is not in the active snapshot', async () => {
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [group],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(manager.has).toHaveBeenCalledWith(group.group);
        expect(manager.delete).toHaveBeenCalledWith(group.group);
    });

    it('cleans up RTC group tracking and notifies listeners when a group snapshot is removed', async () => {
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-a'],
            1,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            notifyOverlayTopologyChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [group],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();
        listener.mockClear();

        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(group.group);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(manager.delete).toHaveBeenCalledWith(group.group);
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [group],
        });

        unsubscribe();
    });

    it('ignores state event websocket messages in the snapshot cache layer', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);

        dataCaches.initialise(
            webSocketQueueBox as never,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-a', 'event-1'),
                'all',
                AppTopics.groupStateEvent,
                createGroupEvent('room-a', 'event-1'),
            ),
        );
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.clientStateEvent, 'alice', 'event-2'),
                'all',
                AppTopics.clientStateEvent,
                createClientEvent('alice', 'event-2'),
            ),
        );

        expect(listener).not.toHaveBeenCalled();
        expect(manager.notifyClientPresenceChanged).not.toHaveBeenCalled();
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(clientStateSnapshotsRepository.getAllClientStateSnapshots()).toEqual(
            [],
        );
        expect(groupStateSnapshotsRepository.getAllGroupStateSnapshots()).toEqual(
            [],
        );

        unsubscribe();
    });

    it('applies overlay topology websocket snapshots to the local overlay cache', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const groupSnapshot = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a', 'session-b'],
            2,
        );
        const topology: RallarOverlayTopologySnapshot = {
            overlayId: toScopedOverlayId(groupSnapshot.group),
            groupRef: groupSnapshot.group,
            name: 'room-a',
            topology: 'tree',
            activeSessionIds: ['session-a', 'session-b'],
            nextHopsBySessionId: {
                'session-a': ['session-b'],
                'session-b': ['session-a'],
            },
            degreeLimit: 5,
            version: 1,
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
        };

        dataCaches.initialise(
            webSocketQueueBox as never,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-1'),
                'room',
                AppTopics.overlayTopology,
                topology,
                {
                    groupRef: groupSnapshot.group,
                },
            ),
        );

        expect(findOverlayById(topology.overlayId)).toMatchObject({
            overlayId: topology.overlayId,
            groupRef: groupSnapshot.group,
            topology: 'tree',
            nextHopSessionIds: ['session-b'],
            overlayVersion: 1,
        });
        expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledOnce();
    });

    it('uses snapshot hydration as convergence after state event details are missed', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);
        const clientSnapshot = createClientSnapshot(
            'alice',
            'session-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            2,
        );
        const groupSnapshot = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a'],
            2,
        );

        dataCaches.initialise(
            webSocketQueueBox as never,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-a', 'event-1'),
                'all',
                AppTopics.groupStateEvent,
                createGroupEvent('room-a', 'event-1'),
            ),
        );
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.clientStateEvent, 'alice', 'event-2'),
                'all',
                AppTopics.clientStateEvent,
                createClientEvent('alice', 'event-2'),
            ),
        );

        expect(listener).not.toHaveBeenCalled();
        expect(clientStateSnapshotsRepository.getAllClientStateSnapshots()).toEqual(
            [],
        );
        expect(groupStateSnapshotsRepository.getAllGroupStateSnapshots()).toEqual(
            [],
        );

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [clientSnapshot],
            [groupSnapshot],
        );

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots(),
        ).toEqual([clientSnapshot]);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
        ).toEqual([groupSnapshot]);
        expect(listener).toHaveBeenCalledWith({
            clients: [clientSnapshot],
            groups: [],
        });
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [groupSnapshot],
        });

        unsubscribe();
    });
});

function createWebRtcGroupManager() {
    return {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
        notifyOverlayTopologyChanged: vi.fn(async () => undefined),
        acceptGroupUpdate: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        has: vi.fn(() => false),
    } as never;
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
): ClientSnapshot {
    return {
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion,
            profileVersion: snapshotVersion,
            presenceVersion: 1,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        instances: [],
        activeSessions: [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            status: 'active',
            presenceState: 'online',
            transport: 'ws',
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
        }],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion,
    };
}

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    sessionIds: readonly string[],
    snapshotVersion: number,
): GroupSnapshot {
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
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        },
        members: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: 'member',
            status: 'active',
            joined: {
                atEpochMs: 1,
            },
            updated: {
                atEpochMs: snapshotVersion,
            },
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createGroupEvent(
    groupId: string,
    eventId: string,
): GroupEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId,
        eventId,
        eventType: 'member-joined',
        snapshotVersion: 1,
        occurredAtEpochMs: 1,
        actor: {
            principalId: 'alice',
            sessionId: 'session-a',
        },
        requestId: 'request-1',
    };
}

function createClientEvent(
    principalId: string,
    eventId: string,
): ClientEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId,
        eventId,
        eventType: 'session-connected',
        snapshotVersion: 1,
        occurredAtEpochMs: 1,
        actor: {
            principalId,
            sessionId: 'session-a',
        },
        requestId: 'request-2',
    };
}
