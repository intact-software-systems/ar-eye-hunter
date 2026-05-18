import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
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
            'ar-eye-hunter',
            'default',
            1,
        );
        const otherWorkspaceClient = createClientSnapshot(
            'bob',
            'session-b',
            'ar-eye-hunter',
            'workspace-b',
            1,
        );
        const sameScopeGroup = createGroupSnapshot(
            'room-a',
            'ar-eye-hunter',
            'default',
            ['session-a'],
            1,
        );
        const otherWorkspaceGroup = createGroupSnapshot(
            'room-b',
            'ar-eye-hunter',
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
});

function createWebRtcGroupManager() {
    return {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
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
