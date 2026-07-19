import { describe, expect, it } from 'vitest';
import type {
    Group,
    GroupMember,
    GroupPresenceSummary,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import type {
    GroupSnapshotPageOptions,
    GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
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

    it('keeps tuple-preserving liveness projections outside the monotonic summary cache', async () => {
        configureTestCacheRepositories();
        const runtime = new FakeRuntimeStateRepository();
        const repository = new GroupStateRepository(runtime);
        const cache = createGroupStateSnapshotReadThroughCache({
            groupsRepository: repository,
            now: () => 2_000,
        });
        const live = createGroupSnapshot(1, ['session-a']);
        await putGroupSnapshot(repository, live);
        const ref = live.group;
        const primed = await cache.findOrLoadByRef(ref);
        expect(primed?.activeSessions).toHaveLength(1);
        if (!primed) throw new Error('Expected primed snapshot');

        const durable = {
            readSnapshot: (groupRef: GroupRef) => repository.readSnapshot(groupRef),
            listSnapshots: (scope: GroupScope) => repository.listSnapshots(scope),
            listSnapshotsPage: (
                scope: GroupScope,
                options: GroupSnapshotPageOptions,
            ) =>
                repository.listSnapshotsPage(scope, options),
            disconnectPresenceSession: async () => {
                const stored = await repository.findPresenceEntry({
                    ...ref,
                    sessionId: 'session-a',
                });
                if (!stored) throw new Error('Expected persisted session');
                const committed = await repository.updatePresence({
                    ...stored.value,
                    disconnectedAtEpochMs: 2_000,
                    disconnectReason: 'client-disconnect',
                }, stored.entry.revision);
                if (committed.status !== 'applied') {
                    throw new Error('Expected durable disconnect to commit');
                }
                const snapshot = await repository.readSnapshot(ref);
                if (!snapshot) throw new Error('Expected durable snapshot');
                return {
                    status: 'ok' as const,
                    result: Either.ofRight({ snapshot, event: undefined }),
                };
            },
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: (groupRef, options) =>
                    cache.findOrLoadByRef(groupRef, options),
                observe: (snapshot) => cache.observe(snapshot),
            },
        });

        const [disconnectOutcome] = await Promise.allSettled([
            service.disconnectPresenceSession(
                ref,
                ref.groupId,
                'session-a',
                {} as never,
                {} as never,
            ),
        ]);
        const disconnected = await repository.findPresenceSession({
            ...ref,
            sessionId: 'session-a',
        });
        expect(disconnected?.disconnectedAtEpochMs).toBe(2_000);

        const [listOutcome] = await Promise.allSettled([
            service.listSnapshots(ref),
        ]);
        const [pageOutcome] = await Promise.allSettled([
            service.listSnapshotsPage(ref, { limit: 10 }),
        ]);

        expect({
            disconnect: disconnectOutcome.status,
            list: listOutcome.status,
            page: pageOutcome.status,
        }).toEqual({
            disconnect: 'fulfilled',
            list: 'fulfilled',
            page: 'fulfilled',
        });
        if (
            disconnectOutcome.status !== 'fulfilled' ||
            listOutcome.status !== 'fulfilled' ||
            pageOutcome.status !== 'fulfilled'
        ) {
            throw new Error('Expected tuple-preserving projections to return');
        }
        expect(disconnectOutcome.value.result.right?.snapshot.activeSessions)
            .toEqual([]);
        expect(listOutcome.value[0]?.activeSessions).toEqual([]);
        expect(pageOutcome.value.snapshots[0]?.activeSessions).toEqual([]);
        expect(cache.peek(ref)).toEqual(primed);
        await expect(service.readCurrentSnapshot(ref)).resolves.toMatchObject({
            activeSessions: [],
            onlineMemberCount: 0,
        });

        await new GroupPresenceSummaryWork({
            runtimeRepository: runtime,
            now: () => 2_001,
            sleep: () => Promise.resolve(),
            serviceId: 'cache-convergence-test',
        }).converge(ref, 'cache-convergence-delivery');
        const converged = await cache.refreshByRef(ref);
        expect(converged?.activeSessions).toEqual([]);
        expect(converged?.causalRevision.presenceRevision).toBeGreaterThan(
            primed.causalRevision.presenceRevision,
        );
        expect(cache.peek(ref)).toEqual(converged);
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
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId,
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
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            groupId: group.groupId,
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
