import { describe, expect, it, vi } from 'vitest';
import type { AuditStamp, Group, GroupMember } from '@shared/api/group-types.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { type GroupMutationRead } from '@shared-server/rallar-system/services/group-state-mutations.ts';
import {
  groupStateGroupStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
  groupStatePresenceSessionStorageKey,
  groupStatePresenceSummaryStorageKey,
} from '@shared-server/rallar-system/group-state/persistence/group-state-storage-keys.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createSnapshotAssemblyMutationRead } from '../../group-state-persistence-mutation-read-fixtures.ts';
import {
  groupMemberStorageKey,
  groupRef,
  groupStorageKey,
  storedEntry,
} from '../mutation/group-mutation-test-runtime.ts';
describe('GroupStateRepository persistence', () => {
  it('fails closed when persisted active membership exceeds maxMembers', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = new GroupStateRepository(runtime);
    const ref = groupRef('over-capacity-roster');
    const read = createSnapshotAssemblyMutationRead();
    requireMutationGroupAndActor(read);
    const group: Group = {
      ...read.group.value,
      ...ref,
      maxMembers: 1,
      activeMemberCount: 2,
    };
    const owner: GroupMember = {
      ...read.actorMember,
      ...ref,
    };
    const member: GroupMember = {
      ...memberFor('bob'),
      ...ref,
    };
    await repository.putGroup(group);
    await repository.putMember(owner);
    await repository.putMember(member);

    await expect(repository.readSnapshot(ref)).rejects.toMatchObject({
      code: 'group-state-repository-invariant-corruption',
    });
  });
  it('fails closed when a persistence list repeats an inactive member', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = new GroupStateRepository(runtime);
    const ref = groupRef('duplicate-invited-member');
    const read = createSnapshotAssemblyMutationRead();
    requireMutationGroupAndActor(read);
    const group: Group = {
      ...read.group.value,
      ...ref,
    };
    const owner: GroupMember = {
      ...read.actorMember,
      ...ref,
    };
    const invited: GroupMember = {
      ...memberFor('bob'),
      ...ref,
      status: 'invited',
      joined: null,
      left: null,
      removed: null,
      banned: null,
      invitedByPrincipalId: 'alice',
      invitationExpiresAtEpochMs: 10_000,
    };
    await repository.putGroup(group);
    await repository.putMember(owner);
    await repository.putMember(invited);
    const findEntriesByPrefix = runtime.findEntriesByPrefix.bind(runtime);
    vi.spyOn(runtime, 'findEntriesByPrefix').mockImplementation(async (namespace, keyPrefix) => {
      const entries = await findEntriesByPrefix(namespace, keyPrefix);
      if (namespace !== 'group-state:members') return entries;
      const invitedEntry = entries.find((entry) => JSON.parse(entry.value).principalId === 'bob');
      return invitedEntry ? [...entries, invitedEntry] : entries;
    });

    await expect(repository.readSnapshot(ref)).rejects.toMatchObject({
      code: 'group-state-repository-invariant-corruption',
    });
  });

  it('rejects canonically keyed incomplete persisted rows at every public read boundary', async () => {
    const ref = {
      applicationId: 'incomplete-contract-app',
      workspaceId: 'incomplete-contract-workspace',
      groupId: 'incomplete-contract-group',
    };
    const completeGroup: Group = {
      ...createSnapshotAssemblyMutationRead().group!.value,
      ...ref,
      activeMemberCount: 1,
      ownerPrincipalId: 'alice',
    };
    const completeMember: GroupMember = {
      ...requireActiveMember(createSnapshotAssemblyMutationRead().actorMember),
      ...ref,
      principalId: 'alice',
      role: 'owner',
      status: 'active',
      left: null,
      removed: null,
      banned: null,
    };
    const incompleteGroup = structuredClone(completeGroup) as Record<string, unknown>;
    delete incompleteGroup.joinMode;

    const groupRuntime = new FakeRuntimeStateRepository();
    await groupRuntime.upsert(
      'group-state:groups',
      groupStateGroupStorageKey(ref),
      JSON.stringify(incompleteGroup),
      Number.MAX_SAFE_INTEGER,
    );
    const groupRepository = new GroupStateRepository(groupRuntime);
    for (const read of [
      () => groupRepository.findGroup(ref),
      () => groupRepository.findGroupEntry(ref),
      () =>
        groupRepository.listGroups({
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
        }),
      () => groupRepository.readSnapshot(ref),
      () =>
        groupRepository.listSnapshots({
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
        }),
      () =>
        groupRepository.listSnapshotsPage(
          {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
          },
          { limit: 10 },
        ),
    ]) {
      await expect(read()).rejects.toMatchObject({
        code: 'group-state-repository-invariant-corruption',
        storageKey: groupStateGroupStorageKey(ref),
      });
    }

    const incompleteSession = {
      ...ref,
      sessionId: 'incomplete-session',
      principalId: 'alice',
      generationVersion: 1,
      connectedAtEpochMs: 1_000,
      lastHeartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: 10_000,
    };
    const sessionRuntime = new FakeRuntimeStateRepository();
    await sessionRuntime.upsert(
      'group-state:groups',
      groupStateGroupStorageKey(ref),
      JSON.stringify(completeGroup),
      Number.MAX_SAFE_INTEGER,
    );
    await sessionRuntime.upsert(
      'group-state:members',
      groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
      JSON.stringify(completeMember),
      Number.MAX_SAFE_INTEGER,
    );
    const sessionKey = groupStatePresenceSessionStorageKey({
      ...ref,
      sessionId: incompleteSession.sessionId,
    });
    await sessionRuntime.upsert(
      'group-state:sessions',
      sessionKey,
      JSON.stringify(incompleteSession),
      Number.MAX_SAFE_INTEGER,
    );
    const sessionRepository = new GroupStateRepository(sessionRuntime);
    for (const read of [
      () =>
        sessionRepository.findPresenceSession({
          ...ref,
          sessionId: incompleteSession.sessionId,
        }),
      () =>
        sessionRepository.findPresenceEntry({
          ...ref,
          sessionId: incompleteSession.sessionId,
        }),
      () => sessionRepository.listPresenceSessions(ref),
      () => sessionRepository.listPresenceSessionEntries(ref),
      () => sessionRepository.listAllPresenceSessions(),
      () => sessionRepository.readSnapshot(ref),
      () =>
        sessionRepository.listSnapshots({
          applicationId: ref.applicationId,
          workspaceId: ref.workspaceId,
        }),
      () =>
        sessionRepository.listSnapshotsPage(
          {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
          },
          { limit: 10 },
        ),
    ]) {
      await expect(read()).rejects.toMatchObject({
        code: 'group-state-repository-invariant-corruption',
        storageKey: sessionKey,
      });
    }

    const incompleteChildren = [
      {
        namespace: 'group-state:members',
        key: groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
        value: (() => {
          const value = structuredClone(completeMember) as Record<string, unknown>;
          delete value.status;
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
              workspaceId: ref.workspaceId,
            }),
          () =>
            repository.listSnapshotsPage(
              {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
              },
              { limit: 10 },
            ),
        ],
      },
      {
        namespace: 'group-state:presence-admissions',
        key: groupStatePresenceAdmissionStorageKey({ ...ref, principalId: 'alice' }),
        value: {
          ...ref,
          principalId: 'alice',
          admittedSessions: [],
        },
        reads: (repository: GroupStateRepository) => [
          () =>
            repository.findPresenceAdmissionEntry({
              ...ref,
              principalId: 'alice',
            }),
          () => repository.listPresenceAdmissions(ref),
          () => repository.listPresenceAdmissionEntries(ref),
        ],
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
          computedAtEpochMs: 1_000,
        },
        reads: (repository: GroupStateRepository) => [
          () => repository.findPresenceSummaryEntry(ref),
          () => repository.readSnapshot(ref),
          () =>
            repository.listSnapshots({
              applicationId: ref.applicationId,
              workspaceId: ref.workspaceId,
            }),
          () =>
            repository.listSnapshotsPage(
              {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
              },
              { limit: 10 },
            ),
        ],
      },
    ];
    for (const testCase of incompleteChildren) {
      const runtime = new FakeRuntimeStateRepository();
      await runtime.upsert(
        'group-state:groups',
        groupStateGroupStorageKey(ref),
        JSON.stringify(completeGroup),
        Number.MAX_SAFE_INTEGER,
      );
      await runtime.upsert(
        testCase.namespace,
        testCase.key,
        JSON.stringify(testCase.value),
        Number.MAX_SAFE_INTEGER,
      );
      const repository = new GroupStateRepository(runtime);
      for (const read of testCase.reads(repository)) {
        await expect(read()).rejects.toMatchObject({
          code: 'group-state-repository-invariant-corruption',
          storageKey: testCase.key,
        });
      }
    }
  });

  it('validates child entry identity before assembling scope snapshot lists', async () => {
    const runtime = new FakeRuntimeStateRepository();
    const repository = new GroupStateRepository(runtime);
    const ref = {
      applicationId: 'snapshot-child-app',
      workspaceId: 'snapshot-child-workspace',
      groupId: 'snapshot-child-group',
    };
    const group: Group = {
      ...createSnapshotAssemblyMutationRead().group!.value,
      ...ref,
    };
    const wrongScopeMember: GroupMember = {
      ...createSnapshotAssemblyMutationRead().actorMember!,
      ...ref,
      workspaceId: '_',
    };
    await runtime.upsert(
      'group-state:groups',
      groupStateGroupStorageKey(ref),
      JSON.stringify(group),
      Number.MAX_SAFE_INTEGER,
    );
    await runtime.upsert(
      'group-state:members',
      groupStateMemberStorageKey({ ...ref, principalId: 'alice' }),
      JSON.stringify(wrongScopeMember),
      Number.MAX_SAFE_INTEGER,
    );

    await expect(
      repository.listSnapshots({
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
      }),
    ).rejects.toMatchObject({
      code: 'group-state-repository-invariant-corruption',
    });
  });
});

function requireMutationGroupAndActor(read: GroupMutationRead): asserts read is GroupMutationRead &
  Readonly<{
    group: NonNullable<GroupMutationRead['group']>;
    actorMember: GroupMember;
  }> {
  if (!read.group || !read.actorMember) {
    throw new Error('Mutation test fixture requires a group and actor member.');
  }
}

function requireActiveMember(
  member: GroupMember | null,
): Extract<GroupMember, { status: 'active' }> {
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
    updated: audit,
  };
}

function auditStamp(atEpochMs: number, principalId: string, requestId: string | null): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'principal', principalId },
    reason: null,
    traceId: null,
    requestId,
  };
}
