import { describe, expect, it, vi } from 'vitest';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { WebRtcGroupService } from '@shared/services/WebRtcGroupService.ts';

describe('WebRtcGroupService', () => {
    it('accepts newer snapshots, filters self from targets, and ignores stale updates', async () => {
        const cache = new LatestRepository<string, GroupSnapshot>();
        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(rtcQBox as never, 'group-1', cache);
        const events: Array<{
            source: string;
            joinedPeerIds: readonly string[];
            leftPeerIds: readonly string[];
            targetPeerIds: readonly string[];
        }> = [];

        service.onStateDo('state', async (state, diff, source) => {
            events.push({
                source,
                joinedPeerIds: diff.joinedPeerIds,
                leftPeerIds: diff.leftPeerIds,
                targetPeerIds: state.targetPeerIds,
            });
        });

        const first = createGroupSnapshot('group-1', 1, [
            'self',
            'peer-a',
            'peer-b',
        ]);
        const stale = createGroupSnapshot('group-1', 0, ['self', 'peer-c']);
        const second = createGroupSnapshot('group-1', 2, [
            'self',
            'peer-b',
            'peer-c',
        ]);

        await expect(service.acceptGroupUpdate(first)).resolves.toEqual({
            joinedPeerIds: ['peer-a', 'peer-b'],
            leftPeerIds: [],
        });
        await expect(service.acceptGroupUpdate(stale)).resolves.toEqual({
            joinedPeerIds: [],
            leftPeerIds: [],
        });
        await expect(service.acceptGroupUpdate(second)).resolves.toEqual({
            joinedPeerIds: ['peer-c'],
            leftPeerIds: ['peer-a'],
        });

        expect(service.targetPeerIds()).toEqual(['peer-b', 'peer-c']);
        expect(service.state().snapshot?.group.rosterVersion).toBe(2);
        expect(events).toEqual([
            {
                source: 'push',
                joinedPeerIds: ['peer-a', 'peer-b'],
                leftPeerIds: [],
                targetPeerIds: ['peer-a', 'peer-b'],
            },
            {
                source: 'push',
                joinedPeerIds: ['peer-c'],
                leftPeerIds: ['peer-a'],
                targetPeerIds: ['peer-b', 'peer-c'],
            },
        ]);
    });

    it('refreshes from cache using read or peek and supports callback removal', async () => {
        const snapshot = createGroupSnapshot('group-1', 1, ['self', 'peer-a']);
        const cache = {
            read: vi.fn(() => undefined),
            peek: vi.fn(() => snapshot),
        };
        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(
            rtcQBox as never,
            'group-1',
            cache as never,
        );
        const callback = vi.fn(async () => {
        });

        service.onStateDo('state', callback);

        await expect(service.refreshFromCache()).resolves.toEqual({
            joinedPeerIds: ['peer-a'],
            leftPeerIds: [],
        });

        expect(callback).toHaveBeenCalledOnce();
        expect(callback.mock.calls[0]?.[2]).toBe('pull');
        expect(service.peekGroup()).toEqual(snapshot);
        expect(service.removeOnStateCallback('state')).toBe(true);

        await service.refreshFromCache();

        expect(callback).toHaveBeenCalledTimes(1);
    });

    it('rejects updates for the wrong group id', async () => {
        const cache = new LatestRepository<string, GroupSnapshot>();
        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(rtcQBox as never, 'group-1', cache);

        await expect(
            service.acceptGroupUpdate(createGroupSnapshot('group-2', 1, ['self'])),
        ).rejects.toThrow(
            'Received update for wrong room group-2, expected group-1',
        );
    });
});

function createRtcHarness(sessionId: string) {
    return {
        input: {
            sessionId,
        },
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
