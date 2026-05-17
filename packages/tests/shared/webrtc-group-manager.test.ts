import { describe, expect, it, vi } from 'vitest';
import type { ClientInfo } from '@shared/api/api-config.ts';
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
            connectedPeerIds: ['peer-a', 'peer-c'],
            peerOwners: new Map([
                ['peer-a', ['group-1', 'group-2']],
                ['peer-b', ['group-1']],
                ['peer-c', ['group-2']],
            ]),
        });
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

        expect(rtcQBox.connectedPeerIds()).toEqual(['peer-a']);
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
        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-1', 1, ['self', 'peer-a']),
        );

        expect(rtcQBox.connectedPeerIds()).toEqual(['peer-a']);

        await expect(manager.delete('group-1')).resolves.toBe(true);
        expect(rtcQBox.disconnectPeer).toHaveBeenCalledWith('peer-a');
        expect(rtcQBox.connectedPeerIds()).toEqual([]);

        await manager.acceptGroupUpdate(
            createGroupSnapshot('group-2', 1, ['self', 'peer-a']),
        );
        expect(rtcQBox.connectedPeerIds()).toEqual(['peer-a']);

        await manager.clear();

        expect(rtcQBox.disconnectPeer).toHaveBeenLastCalledWith('peer-a');
        expect(manager.size()).toBe(0);
        expect(rtcQBox.connectedPeerIds()).toEqual([]);
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
        expect(rtcQBox.connectedPeerIds()).toEqual([]);
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
        connectedPeerIds: () => Array.from(connectedPeerIds),
        ensurePeerConnectionStarted,
        disconnectPeer,
    };

    return {
        service,
        ensurePeerConnectionStarted,
        disconnectPeer,
        knownPeerIds: service.knownPeerIds,
        connectedPeerIds: service.connectedPeerIds,
        markReconnectable: (peerId: string) => connectedPeerIds.delete(peerId),
    };
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
