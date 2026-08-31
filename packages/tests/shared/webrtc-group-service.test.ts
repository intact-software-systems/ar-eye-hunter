import type { AuditStamp, GroupMember, GroupPresenceSession, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { WebRtcGroupService } from '@shared/services/WebRtcGroupService.ts';
import { describe, expect, it, vi } from 'vitest';
import { configureTestCacheRepositories } from '../configure-test-cache-repositories.ts';
import { createTestGroup } from '../create-test-group.ts';

describe('WebRtcGroupService', () => {
    it('accepts newer snapshots, filters self from targets, and ignores stale updates', async () => {
        const cache = new LatestRepository<string, GroupSnapshot>();
        const rtcQBox = createRtcHarness('self');
        const initial = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self'] });
        const service = new WebRtcGroupService(rtcQBox as never, initial.group, cache);
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
                targetPeerIds: state.targetPeerIds
            });
        });

        const first = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 1,
            memberSessionIds: [
                'self',
                'peer-a',
                'peer-b'
            ]
        });
        const stale = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 0, memberSessionIds: ['self', 'peer-c'] });
        const second = createGroupSnapshot({
            groupId: 'group-1',
            membershipVersion: 2,
            memberSessionIds: [
                'self',
                'peer-b',
                'peer-c'
            ]
        });

        await expect(service.acceptGroupUpdate(first)).resolves.toEqual({
            joinedPeerIds: ['peer-a', 'peer-b'],
            leftPeerIds: []
        });
        await expect(service.acceptGroupUpdate(stale)).resolves.toEqual({
            joinedPeerIds: [],
            leftPeerIds: []
        });
        await expect(service.acceptGroupUpdate(second)).resolves.toEqual({
            joinedPeerIds: ['peer-c'],
            leftPeerIds: ['peer-a']
        });

        expect(service.targetPeerIds()).toEqual(['peer-b', 'peer-c']);
        expect(service.state().snapshot?.group.rosterVersion).toBe(2);
        expect(events).toEqual([
            {
                source: 'push',
                joinedPeerIds: ['peer-a', 'peer-b'],
                leftPeerIds: [],
                targetPeerIds: ['peer-a', 'peer-b']
            },
            {
                source: 'push',
                joinedPeerIds: ['peer-c'],
                leftPeerIds: ['peer-a'],
                targetPeerIds: ['peer-b', 'peer-c']
            }
        ]);
    });

    it('refreshes from cache using read or peek and supports callback removal', async () => {
        const snapshot = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] });
        const cache = {
            read: vi.fn(() => undefined),
            peek: vi.fn(() => snapshot)
        };
        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(
            rtcQBox as never,
            snapshot.group,
            cache as never
        );
        const callbackSources: string[] = [];

        service.onStateDo('state', async (_state, _diff, source) => {
            callbackSources.push(source);
        });

        await expect(service.refreshFromCache()).resolves.toEqual({
            joinedPeerIds: ['peer-a'],
            leftPeerIds: []
        });

        expect(callbackSources).toEqual(['pull']);
        expect(service.peekGroup()).toEqual(snapshot);
        expect(service.removeOnStateCallback('state')).toBe(true);

        await service.refreshFromCache();

        expect(callbackSources).toEqual(['pull']);
    });

    it('reads from the scoped group snapshot repository by group id', async () => {
        configureTestCacheRepositories();

        const snapshot = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a'] });
        groupStateSnapshotsRepository.setGroupStateSnapshot(snapshot);

        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(
            rtcQBox as never,
            snapshot.group,
            groupStateSnapshotsRepository.readableGroupStateSnapshotCache()
        );

        expect(service.readGroup()).toEqual(snapshot);
        expect(service.targetPeerIds()).toEqual(['peer-a']);
        await expect(service.refreshFromCache()).resolves.toEqual({
            joinedPeerIds: [],
            leftPeerIds: []
        });
    });

    it('reads the matching scoped snapshot when same group id exists in multiple workspaces', () => {
        configureTestCacheRepositories();

        const workspaceA = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-a'],
            scope: {
                workspaceId: 'workspace-a'
            }
        });
        const workspaceB = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-b'],
            scope: {
                workspaceId: 'workspace-b'
            }
        });
        groupStateSnapshotsRepository.setGroupStateSnapshots([workspaceA, workspaceB]);

        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(
            rtcQBox as never,
            workspaceB.group,
            groupStateSnapshotsRepository.readableGroupStateSnapshotCache()
        );

        expect(service.readGroup()).toEqual(workspaceB);
        expect(service.targetPeerIds()).toEqual(['peer-b']);
    });

    it('selects the latest matching cached snapshot without direct cache hits', () => {
        const older = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-old'],
            scope: {
                workspaceId: 'workspace-b'
            }
        });
        const latest = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 3,
            memberSessionIds: ['self', 'peer-latest'],
            scope: {
                workspaceId: 'workspace-b'
            }
        });
        const newerWrongScope = createGroupSnapshot({
            groupId: 'shared-room',
            membershipVersion: 99,
            memberSessionIds: ['self', 'peer-wrong'],
            scope: {
                workspaceId: 'workspace-a'
            }
        });
        const cache = {
            read: () => undefined,
            peek: () => undefined,
            readAllValues: () => [
                older,
                newerWrongScope,
                latest
            ]
        };
        const rtcQBox = createRtcHarness('self');
        const service = new WebRtcGroupService(
            rtcQBox as never,
            latest.group,
            cache as never
        );

        expect(service.readGroup()).toEqual(latest);
    });

    it('rejects updates for the wrong group id', async () => {
        const cache = new LatestRepository<string, GroupSnapshot>();
        const rtcQBox = createRtcHarness('self');
        const snapshot = createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self'] });
        const service = new WebRtcGroupService(rtcQBox as never, snapshot.group, cache);

        await expect(
            service.acceptGroupUpdate(createGroupSnapshot({ groupId: 'group-2', membershipVersion: 1, memberSessionIds: ['self'] }))
        ).rejects.toThrow(
            'Received update for wrong room group-2, expected group-1'
        );
    });
});

function createRtcHarness(sessionId: string) {
    return {
        input: {
            sessionId
        }
    };
}

function createGroupSnapshot(input: CreateGroupSnapshotInput): GroupSnapshot {
    const { groupId, membershipVersion, memberSessionIds, scope = {} } = input;
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    const ownerPrincipalId = memberSessionIds[0];
    if (ownerPrincipalId === undefined) {
        throw new Error('Group fixture requires an owner session');
    }

    return {
        causalRevision: {
            groupRevision: membershipVersion,
            presenceRevision: membershipVersion
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            slug: groupId,
            displayName: groupId,
            activeMemberCount: memberSessionIds.length,
            ownerPrincipalId,
            snapshotVersion: membershipVersion,
            metadataVersion: 0,
            rosterVersion: membershipVersion,
            presenceVersion: 0,
            created: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(membershipVersion, ownerPrincipalId)
        }),
        members: memberSessionIds.map((sessionId): GroupMember => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: sessionId === ownerPrincipalId ? 'owner' : 'member',
            status: 'active',
            joined: createAuditStamp(1, ownerPrincipalId),
            updated: createAuditStamp(membershipVersion, ownerPrincipalId),
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null
        })),
        activeSessions: createGroupSessions(input),
        memberCount: memberSessionIds.length,
        onlineMemberCount: memberSessionIds.length
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
interface CreateGroupSnapshotInput {
    readonly groupId: string;
    readonly membershipVersion: number;
    readonly memberSessionIds: readonly string[];
    readonly scope?: Readonly<{
        applicationId?: string;
        workspaceId?: string;
    }>;
}
function createGroupSessions(input: CreateGroupSnapshotInput): GroupSnapshot['activeSessions'] {
    const { groupId, membershipVersion, memberSessionIds, scope = {} } = input;
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return memberSessionIds.map((sessionId): GroupPresenceSession => ({
        applicationId,
        workspaceId,
        groupId,
        sessionId,
        principalId: sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: membershipVersion,
        status: 'active',
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: membershipVersion,
        expiresAtEpochMs: membershipVersion + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null
    }));
}
