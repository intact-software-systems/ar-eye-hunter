import { describe, expect, it } from 'vitest';
import type {
    Group,
    GroupMember,
    GroupPresenceSummary,
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
        await expect(cache.findOrLoadByRef(first.group)).resolves.toEqual(first);

        await putGroupSnapshot(repository, second);
        await expect(cache.findOrLoadByRef(second.group, {
            minCausalRevision: { groupRevision: 2, presenceRevision: 2 },
        })).resolves.toEqual({
            ...second,
            stateRevision: 4,
            causalRevision: { groupRevision: 2, presenceRevision: 2 },
            group: { ...second.group, presenceVersion: 2 },
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
            causalRevision: { groupRevision: 2, presenceRevision: 2 },
        } satisfies GroupSnapshot;
        const revisionOne = {
            ...createGroupSnapshot(99, ['session-stale']),
            stateRevision: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 1 },
        } satisfies GroupSnapshot;

        expect(cache.observe(revisionTwo)).toBe('inserted');
        expect(cache.observe(revisionOne)).toBe('stale');
        expect(cache.observe({
            ...revisionTwo,
            stateRevision: 99,
            causalRevision: { groupRevision: 3, presenceRevision: 1 },
        })).toBe('stale');
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
    const group = await repository.findGroupEntry(snapshot.group);
    if (!group) throw new Error('Expected persisted group');
    const current = await repository.findPresenceSummaryEntry(snapshot.group);
    const presenceRevision = (current?.value.causalRevision.presenceRevision ?? 0) + 1;
    const summary: GroupPresenceSummary = {
        ...snapshot.group,
        causalRevision: {
            groupRevision: group.entry.revision + 1,
            presenceRevision,
        },
        activePrincipalIds: snapshot.activeSessions.map((session) =>
            session.principalId
        ),
        activeSessionIds: snapshot.activeSessions.map((session) =>
            session.sessionId
        ),
        activeSessions: snapshot.activeSessions,
        activePrincipalCount: snapshot.activeSessions.length,
        activeSessionCount: snapshot.activeSessions.length,
        computedAtEpochMs: snapshot.group.updated.atEpochMs,
    };
    if (current) {
        await repository.updatePresenceSummary(summary, current.entry.revision);
    } else {
        await repository.insertPresenceSummary(summary);
    }
}

function createGroupSnapshot(
    snapshotVersion: number,
    sessionIds: readonly string[],
): GroupSnapshot {
    const members: GroupMember[] = [
        {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            joined: { atEpochMs: 1 },
            updated: { atEpochMs: snapshotVersion },
        },
        ...sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId: `principal-${sessionId}`,
            role: 'member' as const,
            status: 'active' as const,
            joined: { atEpochMs: 1 },
            updated: { atEpochMs: snapshotVersion },
        })),
    ];
    const group: Group = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        displayName: 'Group 1',
        kind: 'room',
        status: 'active',
        joinMode: 'open',
        metadata: {},
        activeMemberCount: members.length,
        ownerPrincipalId: 'alice',
        snapshotVersion,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: snapshotVersion,
        created: { atEpochMs: 1 },
        updated: { atEpochMs: snapshotVersion },
    };
    const activeSessions: GroupPresenceSession[] = sessionIds.map(
        (sessionId) => ({
            ...group,
            sessionId,
            principalId: `principal-${sessionId}`,
            generationId: `generation-${sessionId}`,
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 4_000_000_000_000,
        }),
    );

    return {
        stateRevision: snapshotVersion + sessionIds.length,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: sessionIds.length,
        },
        group,
        members,
        activeSessions,
        memberCount: members.length,
        onlineMemberCount: sessionIds.length,
    };
}
