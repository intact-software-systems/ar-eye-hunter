import { type GroupMutationRead } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { groupStateMemberStorageKey } from '@shared-server/rallar-system/group-state/persistence/membership/group-membership-storage-key.ts';
import {
    groupStatePresenceAdmissionStorageKey,
    groupStatePresenceSessionStorageKey,
    groupStatePresenceSummaryStorageKey
} from '@shared-server/rallar-system/group-state/persistence/presence/group-presence-storage-keys.ts';
import { createTestGroupStateRepository } from '@shared-test/shared-server/create-test-state-repositories.ts';
import type { AuditStamp, Group, GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import { describe, expect, it } from 'vitest';
import { FakeRuntimeStateRepository } from '../../../runtime-state/test-support/fake-runtime-state-repository.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { groupMemberStorageKey, groupRef, groupStorageKey, storedEntry } from '../mutation/group-mutation-test-runtime.ts';
import {
    applyPublicationMutation,
    GRANT_ROOM,
    seedGrantRoom,
    writeGrantRow
} from '../mutation/group-publication-grant-test-runtime.ts';
import { createSnapshotAssemblyMutationRead } from './group-state-persistence-mutation-read-fixtures.ts';

describe('GroupStateRepository persistence', () => {
    it('fails closed when persisted active membership exceeds maxMembers', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const ref = groupRef('over-capacity-roster');
        const read = createSnapshotAssemblyMutationRead();
        requireMutationGroupAndActor(read);
        const group: Group = {
            ...read.group.value,
            ...ref,
            maxMembers: 1,
            activeMemberCount: 2
        };
        const owner: GroupMember = {
            ...read.actorMember,
            ...ref
        };
        const member: GroupMember = {
            ...memberFor('bob'),
            ...ref
        };
        await repository.putGroup(group);
        await repository.putMember(owner);
        await repository.putMember(member);

        await expect(repository.readSnapshot(ref)).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });
    it('rejects canonically keyed incomplete persisted rows at every public read boundary', async () => {
        const ref = {
            applicationId: 'incomplete-contract-app',
            workspaceId: 'incomplete-contract-workspace',
            groupId: 'incomplete-contract-group'
        };
        const completeGroup: Group = {
            ...createSnapshotAssemblyMutationRead().group!.value,
            ...ref,
            activeMemberCount: 1,
            ownerPrincipalId: 'alice'
        };
        const completeMember: GroupMember = {
            ...requireActiveMember(createSnapshotAssemblyMutationRead().actorMember),
            ...ref,
            principalId: 'alice',
            role: 'owner',
            status: 'active',
            left: null,
            removed: null,
            banned: null
        };
        const { joinMode: _omittedJoinMode, ...incompleteGroup } = completeGroup;

        const groupRuntime = new FakeRuntimeStateRepository();
        await groupRuntime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(ref),
            JSON.stringify(incompleteGroup),
            Number.MAX_SAFE_INTEGER
        );
        const groupRepository = createTestGroupStateRepository(groupRuntime);
        for (
            const read of [
                () => groupRepository.findGroup(ref),
                () => groupRepository.findGroupEntry(ref),
                () =>
                    groupRepository.listGroups({
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId
                    }),
                () => groupRepository.readSnapshot(ref),
                () =>
                    groupRepository.listSnapshots({
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId
                    }),
                () =>
                    groupRepository.listSnapshotsPage(
                        {
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        },
                        { limit: 10 }
                    )
            ]
        ) {
            await expect(read()).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
                storageKey: groupStateGroupStorageKey(ref)
            });
        }

        const incompleteSession = {
            ...ref,
            sessionId: 'incomplete-session',
            principalId: 'alice',
            generationVersion: 1,
            connectedAtEpochMs: 1_000,
            lastHeartbeatAtEpochMs: 1_000,
            expiresAtEpochMs: 10_000
        };
        const sessionRuntime = new FakeRuntimeStateRepository();
        await sessionRuntime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(ref),
            JSON.stringify(completeGroup),
            Number.MAX_SAFE_INTEGER
        );
        await sessionRuntime.upsert(
            'group-state:members',
            groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
            JSON.stringify(completeMember),
            Number.MAX_SAFE_INTEGER
        );
        const sessionKey = groupStatePresenceSessionStorageKey({
            ...ref,
            sessionId: incompleteSession.sessionId
        });
        await sessionRuntime.upsert(
            'group-state:sessions',
            sessionKey,
            JSON.stringify(incompleteSession),
            Number.MAX_SAFE_INTEGER
        );
        const sessionRepository = createTestGroupStateRepository(sessionRuntime);
        for (
            const read of [
                () =>
                    sessionRepository.findPresenceSession({
                        ...ref,
                        sessionId: incompleteSession.sessionId
                    }),
                () =>
                    sessionRepository.findPresenceEntry({
                        ...ref,
                        sessionId: incompleteSession.sessionId
                    }),
                () => sessionRepository.listPresenceSessions(ref),
                () => sessionRepository.listPresenceSessionEntries(ref),
                () => sessionRepository.listAllPresenceSessions(),
                () => sessionRepository.readSnapshot(ref),
                () =>
                    sessionRepository.listSnapshots({
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId
                    }),
                () =>
                    sessionRepository.listSnapshotsPage(
                        {
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        },
                        { limit: 10 }
                    )
            ]
        ) {
            await expect(read()).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
                storageKey: sessionKey
            });
        }

        const incompleteChildren = [
            {
                namespace: 'group-state:members',
                key: groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
                value: (() => {
                    const { status: _omittedStatus, ...value } = completeMember;
                    return value;
                })(),
                reads: (repository: GroupStateRepository) => [
                    () => repository.findMember({ ...ref, principalId: 'alice' }),
                    () => repository.findMemberEntry({ ...ref, principalId: 'alice' }),
                    () => repository.listMembers(ref),
                    () => repository.listMemberEntries(ref),
                    () => repository.readSnapshot(ref),
                    () =>
                        repository.listSnapshots({
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        }),
                    () =>
                        repository.listSnapshotsPage(
                            {
                                applicationId: ref.applicationId,
                                workspaceId: ref.workspaceId
                            },
                            { limit: 10 }
                        )
                ]
            },
            {
                namespace: 'group-state:presence-admissions',
                key: groupStatePresenceAdmissionStorageKey({ ...ref, principalId: 'alice' }),
                value: {
                    ...ref,
                    principalId: 'alice',
                    admittedSessions: []
                },
                reads: (repository: GroupStateRepository) => [
                    () =>
                        repository.findPresenceAdmissionEntry({
                            ...ref,
                            principalId: 'alice'
                        }),
                    () => repository.listPresenceAdmissions(ref),
                    () => repository.listPresenceAdmissionEntries(ref)
                ]
            },
            {
                namespace: 'group-state:presence-summaries',
                key: groupStatePresenceSummaryStorageKey(ref),
                value: {
                    ...ref,
                    activePrincipalIds: [],
                    activeSessionIds: [],
                    activeSessions: [],
                    activePrincipalCount: 0,
                    activeSessionCount: 0,
                    computedAtEpochMs: 1_000
                },
                reads: (repository: GroupStateRepository) => [
                    () => repository.findPresenceSummaryEntry(ref),
                    () => repository.readSnapshot(ref),
                    () =>
                        repository.listSnapshots({
                            applicationId: ref.applicationId,
                            workspaceId: ref.workspaceId
                        }),
                    () =>
                        repository.listSnapshotsPage(
                            {
                                applicationId: ref.applicationId,
                                workspaceId: ref.workspaceId
                            },
                            { limit: 10 }
                        )
                ]
            }
        ];
        for (const testCase of incompleteChildren) {
            const runtime = new FakeRuntimeStateRepository();
            await runtime.upsert(
                'group-state:groups',
                groupStateGroupStorageKey(ref),
                JSON.stringify(completeGroup),
                Number.MAX_SAFE_INTEGER
            );
            await runtime.upsert(
                testCase.namespace,
                testCase.key,
                JSON.stringify(testCase.value),
                Number.MAX_SAFE_INTEGER
            );
            const repository = createTestGroupStateRepository(runtime);
            for (const read of testCase.reads(repository)) {
                await expect(read()).rejects.toMatchObject({
                    code: 'group-state-repository-invariant-corruption',
                    storageKey: testCase.key
                });
            }
        }
    });

    it('validates child entry identity before assembling scope snapshot lists', async () => {
        const runtime = new FakeRuntimeStateRepository();
        const repository = createTestGroupStateRepository(runtime);
        const ref = {
            applicationId: 'snapshot-child-app',
            workspaceId: 'snapshot-child-workspace',
            groupId: 'snapshot-child-group'
        };
        const group: Group = {
            ...createSnapshotAssemblyMutationRead().group!.value,
            ...ref
        };
        const wrongScopeMember: GroupMember = {
            ...createSnapshotAssemblyMutationRead().actorMember!,
            ...ref,
            workspaceId: '_'
        };
        await runtime.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(ref),
            JSON.stringify(group),
            Number.MAX_SAFE_INTEGER
        );
        await runtime.upsert(
            'group-state:members',
            groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
            JSON.stringify(wrongScopeMember),
            Number.MAX_SAFE_INTEGER
        );

        await expect(
            repository.listSnapshots({
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId
            })
        ).rejects.toMatchObject({
            code: 'group-state-repository-invariant-corruption'
        });
    });

    it('every snapshot read carries the group\'s grant rows in principal order', async () => {
        const runtime = new GroupBarrierRepository();
        await seedGrantRoom(runtime);
        for (const targetPrincipalId of ['erin', 'bob']) {
            await applyPublicationMutation(runtime, {
                operation: 'grantGroupPublication',
                actorPrincipalId: 'alice',
                targetPrincipalId,
                topicId: 'room.feed',
                publish: true,
                subscribe: true,
                requestId: `grant-${targetPrincipalId}-feed-in-order`
            });
        }

        for (const read of snapshotReads(createTestGroupStateRepository(runtime))) {
            const snapshot = await read();
            expect(snapshot?.publicationGrants.map((grant) => grant.principalId)).toEqual(['bob', 'erin']);
        }
    });

    it('assembly refuses a grant row for a principal the group does not list', async () => {
        const runtime = new GroupBarrierRepository();
        await seedGrantRoom(runtime);
        await writeGrantRow(runtime, 'zed', { 'room.feed': { publish: true, subscribe: true } });

        for (const read of snapshotReads(createTestGroupStateRepository(runtime))) {
            await expect(read()).rejects.toMatchObject({
                code: 'group-state-repository-invariant-corruption',
                storageKey: groupStateGroupStorageKey(groupRef(GRANT_ROOM))
            });
        }
    });
});

/** Each public read that assembles the grant room's snapshot. */
function snapshotReads(repository: GroupStateRepository): readonly (() => Promise<GroupSnapshot | undefined>)[] {
    const ref = groupRef(GRANT_ROOM);
    const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
    const inRoom = (snapshots: readonly GroupSnapshot[]) => snapshots.find((snapshot) => snapshot.group.groupId === GRANT_ROOM);
    return [
        () => repository.readSnapshot(ref),
        async () => inRoom(await repository.listSnapshots(scope)),
        async () => inRoom((await repository.listSnapshotsPage(scope, { limit: 10 })).snapshots),
        async () => inRoom(await repository.listSnapshotsForPrincipal(scope, 'alice'))
    ];
}

function requireMutationGroupAndActor(read: GroupMutationRead): asserts read is
    & GroupMutationRead
    & Readonly<{
        group: NonNullable<GroupMutationRead['group']>;
        actorMember: GroupMember;
    }> {
    if (!read.group || !read.actorMember) {
        throw new Error('Mutation test fixture requires a group and actor member.');
    }
}

function requireActiveMember(
    member: GroupMember | null
): Extract<GroupMember, { status: 'active'; }> {
    if (member?.status !== 'active') {
        throw new Error('Mutation test fixture requires an active actor member.');
    }
    return member;
}

function memberFor(principalId: string): GroupMember {
    const audit = auditStamp(1_000, 'alice', 'seed');
    return {
        ...groupRef('pure-room'),
        principalId,
        role: 'member',
        status: 'active',
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
        joined: audit,
        updated: audit
    };
}

function auditStamp(atEpochMs: number, principalId: string, requestId: string | null): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'principal', principalId },
        reason: null,
        traceId: null,
        requestId
    };
}
