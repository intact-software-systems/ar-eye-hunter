import { describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { Either } from '@shared/resilience/Either.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';

describe('WebRtcGroupManager', () => {
    it('reconciles desired groups against online clients and connection state', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self', ['peer-orphan']);
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', false));
        clientCache.set('peer-c', createClientInfo('peer-c', true));

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, ['self', 'peer-a', 'peer-b']),
        );
        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-2', 1, ['self', 'peer-a', 'peer-c']),
        );

        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenCalledTimes(2);
        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenNthCalledWith(1, 'peer-a');
        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenNthCalledWith(2, 'peer-c');
        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-orphan');
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1', 'group-2']);
        expect(manager.isPeerOwnedByAnyGroup('peer-b')).toBe(true);

        expect(manager.state()).toEqual({
            groupIds: ['group-1', 'group-2'],
            desiredPeerIds: ['peer-a', 'peer-b', 'peer-c'],
            onlinePeerIds: ['peer-a', 'peer-c'],
            onlineDesiredPeerIds: ['peer-a', 'peer-c'],
            connectablePeerIds: ['peer-a', 'peer-c'],
            peerIdsWithNoReconnectableLanes: ['peer-a', 'peer-c'],
            peerOwners: new Map([
                ['peer-a', ['group-1', 'group-2']],
                ['peer-b', ['group-1']],
                ['peer-c', ['group-2']],
            ]),
        });
    });

    it('reads online peers once when materializing manager state', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new CountingClientCache();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        clientCache.set('peer-c', createClientInfo('peer-c', false));

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, [
                'self',
                'peer-a',
                'peer-b',
                'peer-c',
            ]),
        );

        clientCache.resetCounters();

        expect(manager.state()).toMatchObject({
            onlinePeerIds: ['peer-a', 'peer-b'],
            onlineDesiredPeerIds: ['peer-a', 'peer-b'],
        });
        expect(clientCache.keysCalls).toBe(1);
    });

    it('updates cached peer owners after group membership changes', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, ['self', 'peer-a']),
        );

        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1']);
        expect(manager.isPeerOwnedByAnyGroup('peer-b')).toBe(false);

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 2, ['self', 'peer-b']),
        );

        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual([]);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['group-1']);
        expect(manager.isPeerOwnedByAnyGroup('peer-b')).toBe(true);
    });

    it('does not duplicate reconciliations once sync start records a peer', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));

        const first = manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, ['self', 'peer-a']),
        );
        const second = manager.ensureAllGroupsConnected();
        const third = manager.notifyClientPresenceChanged();

        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenCalledTimes(1);

        await Promise.all([first, second, third]);

        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);
    });

    it('tracks same group id snapshots from different workspaces independently', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));

        await manager.acceptGroupUpdate(
            createGroupSnapshot(
                'shared-room',
                1,
                ['self', 'peer-a'],
                {
                    workspaceId: 'workspace-a',
                },
            ),
        );
        await manager.acceptGroupUpdate(
            createGroupSnapshot(
                'shared-room',
                1,
                ['self', 'peer-b'],
                {
                    workspaceId: 'workspace-b',
                },
            ),
        );

        expect(manager.size()).toBe(2);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes().sort()).toEqual(['peer-a', 'peer-b']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['shared-room']);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['shared-room']);
    });

    it('deletes only the matching scoped group when same group id exists in multiple workspaces', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );
        const workspaceA = createGroupSnapshot(
            'shared-room',
            1,
            ['self', 'peer-a'],
            {
                workspaceId: 'workspace-a',
            },
        );
        const workspaceB = createGroupSnapshot(
            'shared-room',
            1,
            ['self', 'peer-b'],
            {
                workspaceId: 'workspace-b',
            },
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        await manager.acceptGroupUpdate(workspaceA);
        await manager.acceptGroupUpdate(workspaceB);

        await expect(manager.delete(workspaceA.group)).resolves.toBe(true);

        expect(manager.size()).toBe(1);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-b']);
        expect(manager.getIfPresent(workspaceA.group)).toBeUndefined();
        expect(manager.getIfPresent(workspaceB.group)?.targetPeerIds()).toEqual(['peer-b']);
    });

    it('disconnects peers when groups are deleted or cleared', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        const group1 = createGroupSnapshot('group-1', 1, ['self', 'peer-a']);
        await manager.acceptGroupUpdate(group1);

        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);

        await expect(manager.delete(group1.group)).resolves.toBe(true);
        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-a');
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-2', 1, ['self', 'peer-a']),
        );
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual(['peer-a']);

        await manager.clear();

        expect(rtcQBox.disconnectPeer).toHaveBeenLastCalledWith('peer-a');
        expect(manager.size()).toBe(0);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);
    });

    it('disconnects stale known peers when they leave all groups', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self', ['peer-a']);
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, ['self', 'peer-a']),
        );

        rtcQBox.markReconnectable('peer-a');
        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 2, ['self']),
        );

        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-a');
        expect(rtcQBox.knownPeerIds()).toEqual([]);
        expect(rtcQBox.peerIdsWithNoReconnectableLanes()).toEqual([]);
    });

    it('retains left-room peers below the inactive connection budget', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
            undefined,
            { maxPeerConnections: 10 },
        );

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        const group = createGroupSnapshot('group-1', 1, ['self', 'peer-a']);
        await manager.acceptGroupUpdate(group);

        await expect(manager.delete(group.group, { retainConnections: true }))
            .resolves.toBe(true);

        expect(manager.size()).toBe(0);
        expect(rtcQBox.disconnectPeer).not.toHaveBeenCalledWith('peer-a');
        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
    });

    it('evicts the oldest retained inactive peers when the connection budget is exceeded', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
            undefined,
            { maxPeerConnections: 5 },
        );
        const retainedPeerIds = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'];

        for (const peerId of [...retainedPeerIds, 'peer-f']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        const oldGroup = createGroupSnapshot('group-1', 1, [
            'self',
            ...retainedPeerIds,
        ]);
        await manager.acceptGroupUpdate(oldGroup);
        await manager.delete(oldGroup.group, { retainConnections: true });

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-2', 1, ['self', 'peer-f']),
        );

        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-a');
        expect(rtcQBox.knownPeerIds().sort()).toEqual([
            'peer-b',
            'peer-c',
            'peer-d',
            'peer-e',
            'peer-f',
        ]);
    });

    it('uses overlay next hops as desired RTC peers when topology is available', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const overlayCache = new LatestRepository<string, OverlayInfo>();
        const rtcQBox = createRtcQBoxHarness('self');
        const manager = new WebRtcGroupManager(
            rtcQBox.service as never,
            groupCache,
            clientCache,
            overlayCache,
            { maxPeerConnections: 10 },
        );
        const group = createGroupSnapshot('group-1', 1, [
            'self',
            'peer-a',
            'peer-b',
            'peer-c',
        ]);
        const overlayId = toScopedOverlayId(group.group);

        clientCache.set('peer-a', createClientInfo('peer-a', true));
        clientCache.set('peer-b', createClientInfo('peer-b', true));
        clientCache.set('peer-c', createClientInfo('peer-c', true));
        overlayCache.set(overlayId, createOverlayInfo(group, ['peer-a']));

        await manager.acceptGroupUpdate(group);

        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenCalledTimes(1);
        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenCalledWith('peer-a');
        expect(manager.state().desiredPeerIds).toEqual(['peer-a']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual(['group-1']);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual([]);

        overlayCache.set(overlayId, createOverlayInfo(group, ['peer-b'], 2));
        await manager.notifyOverlayTopologyChanged();

        expect(rtcQBox.ensurePeerConnectionStarted).toHaveBeenCalledWith('peer-b');
        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-a');
        expect(manager.state().desiredPeerIds).toEqual(['peer-b']);
        expect(manager.ownerGroupsOfPeer('peer-a')).toEqual([]);
        expect(manager.ownerGroupsOfPeer('peer-b')).toEqual(['group-1']);
    });
});

function createRtcQBoxHarness(
    sessionId: string,
    initiallyConnectedPeerIds: readonly string[] = [],
    connectImpl?: (
        peerId: string,
        connectedPeerIds: Set<string>,
    ) => void,
) {
    const knownPeerIds = new Set(initiallyConnectedPeerIds);
    const connectedPeerIds = new Set(initiallyConnectedPeerIds);

    const ensurePeerConnectionStarted = vi.fn((peerId: string) => {
        knownPeerIds.add(peerId);
        if (connectImpl) {
            connectImpl(peerId, connectedPeerIds);
            return Either.ofRight({ peerId } as never);
        }

        connectedPeerIds.add(peerId);
        return Either.ofRight({ peerId } as never);
    });

    const disconnectPeer = vi.fn((peerId: string) => {
        knownPeerIds.delete(peerId);
        return connectedPeerIds.delete(peerId);
    });

    const service = {
        input: {
            sessionId,
        },
        knownPeerIds: () => Array.from(knownPeerIds),
        peerIdsWithNoReconnectableLanes: () => Array.from(connectedPeerIds),
        ensurePeerConnectionStarted,
        disconnectPeer,
    };

    return {
        service,
        ensurePeerConnectionStarted,
        disconnectPeer,
        knownPeerIds: service.knownPeerIds,
        peerIdsWithNoReconnectableLanes: service.peerIdsWithNoReconnectableLanes,
        markReconnectable: (peerId: string) => connectedPeerIds.delete(peerId),
    };
}

class CountingClientCache extends LatestRepository<string, ClientInfo> {
    keysCalls = 0;

    override keys(): IterableIterator<string> {
        this.keysCalls += 1;
        return super.keys();
    }

    resetCounters(): void {
        this.keysCalls = 0;
    }
}

function createClientInfo(sessionId: string, isOnline: boolean): ClientInfo {
    return {
        clientId: sessionId,
        sessionId,
        isOnline,
    };
}

function createGroupSnapshot(
    groupId: string,
    membershipVersion: number,
    memberSessionIds: readonly string[],
    scope: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }> = {},
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';

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
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: {
                atEpochMs: 1,
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'creator',
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
                byPrincipalId: 'creator',
            },
            updated: {
                atEpochMs: membershipVersion,
                byPrincipalId: 'creator',
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

function createOverlayInfo(
    group: GroupSnapshot,
    nextHopSessionIds: readonly string[],
    overlayVersion = 1,
): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: group.group.created.byPrincipalId,
        createdAtEpochMs: group.group.created.atEpochMs,
        nextHopSessionIds,
        overlayVersion,
        updatedAtEpochMs: overlayVersion,
    };
}
