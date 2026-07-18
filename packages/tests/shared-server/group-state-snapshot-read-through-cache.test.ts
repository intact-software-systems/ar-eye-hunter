import { describe, expect, it } from 'vitest';
import type {
    Group,
    GroupMember,
    GroupPresenceSession,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';

describe('GroupStateSnapshotReadThroughCache', () => {
    it('hydrates and refreshes by durable state revision', async () => {
        configureTestCacheRepositories();
        const repository = new GroupStateRepository(
            new FakeRuntimeStateRepository(),
        );
        const cache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: repository,
        });
        const first = createGroupSnapshot(1, ['session-a']);
        const second = createGroupSnapshot(1, ['session-a', 'session-b']);

        await putGroupSnapshot(repository, first);
        await expect(cache.findOrLoadByRef(first.group)).resolves.toEqual({
            ...first,
            stateRevision: 1,
        });

        await putGroupSnapshot(repository, second);
        await expect(cache.findOrLoadByRef(second.group, {
            minStateRevision: 2,
        })).resolves.toEqual({
            ...second,
            stateRevision: 2,
        });
    });

    it('observes revisions monotonically and rejects equal-revision conflicts', () => {
        configureTestCacheRepositories();
        const repository = new GroupStateRepository(
            new FakeRuntimeStateRepository(),
        );
        const cache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: repository,
        });
        const revisionTwo = {
            ...createGroupSnapshot(1, ['session-new']),
            stateRevision: 2,
        } satisfies GroupSnapshot;
        const revisionOne = {
            ...createGroupSnapshot(99, ['session-stale']),
            stateRevision: 1,
        } satisfies GroupSnapshot;

        expect(cache.observe(revisionTwo)).toBe('inserted');
        expect(cache.observe(revisionOne)).toBe('stale');
        expect(cache.observe(revisionTwo)).toBe('duplicate');
        expect(() => cache.observe({
            ...revisionTwo,
            onlineMemberCount: 0,
        })).toThrow('Group snapshot revision conflict');
        expect(cache.peek(revisionTwo.group)).toEqual(revisionTwo);
    });
});

async function putGroupSnapshot(
    repository: GroupStateRepository,
    snapshot: GroupSnapshot,
): Promise<void> {
    await repository.putGroup(snapshot.group);
    await Promise.all(snapshot.members.map((member) => repository.putMember(member)));
    await Promise.all(
        snapshot.activeSessions.map((session) =>
            repository.putPresenceSession(session)
        ),
    );
}

function createGroupSnapshot(
    snapshotVersion: number,
    sessionIds: readonly string[],
): GroupSnapshot {
    const group: Group = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        displayName: 'Group 1',
        kind: 'room',
        status: 'active',
        joinMode: 'open',
        metadata: {},
        snapshotVersion,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: snapshotVersion,
        created: { atEpochMs: 1 },
        updated: { atEpochMs: snapshotVersion },
    };
    const members: GroupMember[] = sessionIds.map((sessionId) => ({
        ...group,
        principalId: `principal-${sessionId}`,
        role: 'member',
        status: 'active',
        joined: { atEpochMs: 1 },
        updated: { atEpochMs: snapshotVersion },
    }));
    const activeSessions: GroupPresenceSession[] = sessionIds.map(
        (sessionId) => ({
            ...group,
            sessionId,
            principalId: `principal-${sessionId}`,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 4_000_000_000_000,
        }),
    );

    return {
        group,
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: members.length,
    };
}
