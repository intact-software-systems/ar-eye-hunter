import { describe, expect, it } from 'vitest';
import type {
    AuditStamp,
    Group,
    GroupMember,
    GroupPresenceSummary,
    GroupPresenceSession,
    GroupRef,
    GroupScope,
    GroupSnapshot,
} from '@shared/api/group-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { GroupPresenceSummaryWork } from '@shared-server/rallar-system/services/GroupPresenceSummaryWork.ts';
import type { GroupPresenceSummaryWorkData } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { createCachedGroupStateService } from '@shared-server/rallar-system/services/cached-group-state-service.ts';
import { createGroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/services/group-state-snapshot-read-through-cache.ts';
import type {
    GroupSnapshotPageOptions,
    GroupStateService,
} from '@shared-server/rallar-system/services/group-state-service.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { FakeRuntimeStateRepository } from './fake-runtime-state-repository.ts';
import { requireConditionalWrite } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

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
        const second = createGroupSnapshot(2, ['session-a', 'session-b']);

        await putGroupSnapshot(repository, first);
        await expect(cache.findOrLoadByRef(first.group)).resolves.toEqual(first);

        await putGroupSnapshot(repository, second);
        await expect(cache.findOrLoadByRef(second.group, {
            minCausalRevision: { groupRevision: 2, presenceRevision: 2 },
        })).resolves.toEqual(second);
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
        })).toBe('incomparable');
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
        } as unknown as GroupStateService;
        const service = createCachedGroupStateService({
            durable,
            cache: {
                findOrLoadByRef: (groupRef, options) =>
                    cache.findOrLoadByRef(groupRef, options),
                observe: (snapshot) => cache.observe(snapshot),
            },
        });

        const stored = await repository.findPresenceEntry({
            ...ref,
            sessionId: 'session-a',
        });
        if (!stored) throw new Error('Expected persisted session');
        requireConditionalWrite(await repository.updatePresence({
            ...stored.value,
            status: 'disconnected',
            disconnectedAtEpochMs: 2_000,
            disconnectReason: 'client-disconnect',
        }, stored.entry.revision));
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
            list: listOutcome.status,
            page: pageOutcome.status,
        }).toEqual({
            list: 'fulfilled',
            page: 'fulfilled',
        });
        if (
            listOutcome.status !== 'fulfilled' ||
            pageOutcome.status !== 'fulfilled'
        ) {
            throw new Error('Expected tuple-preserving projections to return');
        }
        expect(listOutcome.value[0]?.activeSessions).toEqual([]);
        expect(pageOutcome.value.snapshots[0]?.activeSessions).toEqual([]);
        expect(cache.peek(ref)).toEqual(primed);
        await expect(service.readCurrentSnapshot(ref)).resolves.toMatchObject({
            activeSessions: [],
            onlineMemberCount: 0,
        });

        await convergePresenceSummaryForCacheTest(runtime, repository, ref);
        const converged = await cache.refreshByRef(ref);
        expect(converged?.activeSessions).toEqual([]);
        expect(converged?.causalRevision.presenceRevision).toBeGreaterThan(
            primed.causalRevision.presenceRevision,
        );
        expect(cache.peek(ref)).toEqual(converged);
    });
});

async function convergePresenceSummaryForCacheTest(
    runtime: FakeRuntimeStateRepository,
    repository: GroupStateRepository,
    ref: GroupRef,
): Promise<void> {
    const groupRef: GroupRef = {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId,
    };
    const group = await repository.findGroupEntry(groupRef);
    const current = await repository.findPresenceSummaryEntry(groupRef);
    if (!group) throw new Error('Expected stored group');
    const acceptedCausalRevision = {
        groupRevision: group.entry.revision + 1,
        presenceRevision: current?.value.causalRevision.presenceRevision ?? 0,
    };
    const command: GroupPresenceSummaryWorkData = {
        effectKind: 'group-presence-summary',
        aggregateRef: groupRef,
        commandId: 'cache-convergence-delivery',
        createdAtEpochMs: 2_000,
        expireAtEpochMs: 253_402_300_799_999,
        acceptedCausalRevision,
        event: {
            applicationId: groupRef.applicationId,
            workspaceId: groupRef.workspaceId,
            groupId: groupRef.groupId,
            eventId: 'cache-convergence-event',
            eventType: 'session-disconnected',
            snapshotVersion: group.value.snapshotVersion,
            causalRevision: acceptedCausalRevision,
            occurredAtEpochMs: 2_000,
            actor: { kind: 'service', serviceId: 'cache-convergence-test' },
            reason: 'client-disconnect',
            traceId: null,
            requestId: 'cache-convergence-delivery',
            payload: {},
        },
    };
    const work = new GroupPresenceSummaryWork({
        runtimeRepository: runtime,
        now: () => 2_001,
        serviceId: 'cache-convergence-test',
    });
    const read = await work.read(command);
    const computed = work.compute(command, read);
    work.validate(command, read, computed);
    await runtime.begin(async (transaction) => {
        if (computed.summary.outcome === 'no-op') return;
        const transactionRepository = new GroupStateRepository(transaction);
        requireConditionalWrite(
            computed.summary.operation === 'insert'
                ? await transactionRepository.insertPresenceSummary(computed.summary.summary)
                : await transactionRepository.updatePresenceSummary(
                    computed.summary.summary,
                    computed.summary.expectedRevision!,
                ),
        );
    });
}

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
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(snapshotVersion),
        },
        ...sessionIds.map((sessionId) => ({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
            principalId: `principal-${sessionId}`,
            role: 'member' as const,
            status: 'active' as const,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
            left: null,
            removed: null,
            banned: null,
            joined: audit(1),
            updated: audit(snapshotVersion),
        })),
    ];
    const group: Group = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        slug: null,
        displayName: 'Group 1',
        description: null,
        kind: 'room',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'open',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: members.length,
        ownerPrincipalId: 'alice',
        snapshotVersion,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: snapshotVersion,
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null,
        created: audit(1),
        updated: audit(snapshotVersion),
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
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
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

function audit(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
