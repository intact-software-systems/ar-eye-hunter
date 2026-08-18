import { describe, expect, it } from 'vitest';
import {
  AppInboxType,
  type GroupCreateAppInboxPayload,
  type GroupDirectorAppointAppInboxPayload,
  type GroupInviteAcceptAppInboxPayload,
  type GroupInviteRevokeAppInboxPayload,
  type GroupJoinAppInboxPayload,
  type GroupJoinCodeRotateAppInboxPayload,
  type GroupMemberRemoveAppInboxPayload,
  type GroupMemberRoleSetAppInboxPayload,
  type GroupMemberUpsertAppInboxPayload,
  type GroupOwnershipTransferAppInboxPayload,
  type GroupPresenceConnectAppInboxPayload,
  type GroupPresenceDisconnectAppInboxPayload,
  type GroupPresenceHeartbeatAppInboxPayload,
  type GroupUpdateAppInboxPayload,
} from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import * as AppGroupInboxModule from '@shared-server/rallar-system/services/AppGroupInboxService.ts';
import {
  SCOPE,
  createAuthorityHarness,
  createGovernedOperationCase,
  createInviteOperationCase,
  readMatrixMember,
  readMatrixPresenceSession,
  runOperationMatrix,
  type OperationMatrixCase,
} from './group-state-inbox-test-runtime.ts';

describe('AppGroupInboxService authenticated authority', () => {
  it('exposes transaction-injected mutation phases without direct mutation bypasses', async () => {
    const harness = await createAuthorityHarness(['owner']);
    expect(harness.groupStateService).toMatchObject({
      read: expect.any(Function),
      compute: expect.any(Function),
      validate: expect.any(Function),
      write: expect.any(Function),
    });
    for (const method of [
      'createGroup',
      'updateGroup',
      'joinGroup',
      'upsertMember',
      'connectPresenceSession',
      'heartbeatPresenceSession',
      'disconnectPresenceSession',
    ]) {
      expect(Reflect.get(harness.groupStateService, method)).toBeUndefined();
    }
  });

  it('advertises every authenticated group operation covered by the real handler matrix', () => {
    expect(Reflect.get(AppGroupInboxModule, 'AUTHENTICATED_GROUP_INBOX_TYPES')).toEqual([
      AppInboxType.GROUP_CREATE,
      AppInboxType.GROUP_UPDATE,
      AppInboxType.GROUP_DIRECTOR_APPOINT,
      AppInboxType.GROUP_ESTABLISHMENT_START,
      AppInboxType.GROUP_ACTIVATE,
      AppInboxType.GROUP_ESTABLISHMENT_REOPEN,
      AppInboxType.GROUP_JOIN,
      AppInboxType.GROUP_INVITE_CREATE,
      AppInboxType.GROUP_INVITE_REVOKE,
      AppInboxType.GROUP_INVITE_ACCEPT,
      AppInboxType.GROUP_JOIN_CODE_ROTATE,
      AppInboxType.GROUP_MEMBER_REMOVE,
      AppInboxType.GROUP_MEMBER_BAN,
      AppInboxType.GROUP_MEMBER_UNBAN,
      AppInboxType.GROUP_MEMBER_ROLE_SET,
      AppInboxType.GROUP_OWNERSHIP_TRANSFER,
      AppInboxType.GROUP_MEMBER_UPSERT,
      AppInboxType.GROUP_PRESENCE_CONNECT,
      AppInboxType.GROUP_PRESENCE_HEARTBEAT,
      AppInboxType.GROUP_PRESENCE_DISCONNECT,
    ]);
  });

  it(
    'runs every advertised group operation through real AppGroup phases and one transaction',
    runEveryAdvertisedGroupOperation,
    30_000,
  );
});

async function runEveryAdvertisedGroupOperation(): Promise<void> {
  const harness = await createAuthorityHarness(['owner', 'bob', 'charlie']);
  const groupId = 'operation-matrix-room';
  const ownerActor = {
    actorPrincipalId: 'owner',
    actorSessionId: 'owner-session',
  } as const;
  const bobActor = {
    actorPrincipalId: 'bob',
    actorSessionId: 'bob-session',
  } as const;
  const charlieActor = {
    actorPrincipalId: 'charlie',
    actorSessionId: 'charlie-session',
  } as const;
  const cases: readonly OperationMatrixCase[] = [
    {
      type: AppInboxType.GROUP_CREATE,
      operation: 'createGroup',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        request: {
          groupId,
          displayName: 'Operation Matrix',
          kind: 'room',
          joinMode: 'open',
          createdByPrincipalId: 'owner',
          ...ownerActor,
          requestId: 'matrix-create',
        },
      } satisfies GroupCreateAppInboxPayload,
      assertDomain: async () => {
        expect(
          (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.displayName,
        ).toBe('Operation Matrix');
      },
    },
    {
      type: AppInboxType.GROUP_UPDATE,
      operation: 'updateGroup',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        request: {
          description: 'Updated through AppGroup',
          ...ownerActor,
          requestId: 'matrix-update',
        },
      } satisfies GroupUpdateAppInboxPayload,
      assertDomain: async () => {
        expect(
          (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.description,
        ).toBe('Updated through AppGroup');
      },
    },
    {
      type: AppInboxType.GROUP_JOIN,
      operation: 'joinGroup',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        request: { ...bobActor, requestId: 'matrix-join-bob' },
      } satisfies GroupJoinAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'bob')).toMatchObject({
          status: 'active',
          role: 'member',
        });
      },
    },
    createInviteOperationCase({
      harness,
      groupId,
      ownerActor,
      requestId: 'matrix-invite-charlie',
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'invited',
          invitedByPrincipalId: 'owner',
        });
      },
    }),
    {
      type: AppInboxType.GROUP_INVITE_REVOKE,
      operation: 'revokeGroupInvite',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        principalId: 'charlie',
        request: { ...ownerActor, requestId: 'matrix-revoke-charlie' },
      } satisfies GroupInviteRevokeAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'left',
        });
      },
    },
    createInviteOperationCase({
      harness,
      groupId,
      ownerActor,
      requestId: 'matrix-reinvite-charlie',
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'invited',
        });
      },
    }),
    {
      type: AppInboxType.GROUP_INVITE_ACCEPT,
      operation: 'acceptGroupInvite',
      authority: harness.sessions.charlie,
      data: {
        scope: SCOPE,
        groupId,
        request: { ...charlieActor, requestId: 'matrix-accept-charlie' },
      } satisfies GroupInviteAcceptAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'active',
        });
      },
    },
    {
      type: AppInboxType.GROUP_JOIN_CODE_ROTATE,
      operation: 'rotateGroupJoinCode',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        request: {
          joinCode: 'MATRIX42',
          expiresAtEpochMs: harness.nowEpochMs + 120_000,
          ...ownerActor,
          requestId: 'matrix-rotate-code',
        },
      } satisfies GroupJoinCodeRotateAppInboxPayload,
      assertDomain: async () => {
        expect(
          (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.group.metadata,
        ).toHaveProperty('rallarJoinCode');
      },
    },
    {
      type: AppInboxType.GROUP_MEMBER_ROLE_SET,
      operation: 'setGroupMemberRole',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        principalId: 'bob',
        request: { role: 'admin', ...ownerActor, requestId: 'matrix-role-bob' },
      } satisfies GroupMemberRoleSetAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'bob')).toMatchObject({ role: 'admin' });
      },
    },
    createGovernedOperationCase({
      harness,
      groupId,
      ownerActor,
      type: AppInboxType.GROUP_MEMBER_BAN,
      operation: 'banGroupMember',
      requestId: 'matrix-ban-charlie',
      status: 'banned',
    }),
    createGovernedOperationCase({
      harness,
      groupId,
      ownerActor,
      type: AppInboxType.GROUP_MEMBER_UNBAN,
      operation: 'unbanGroupMember',
      requestId: 'matrix-unban-charlie',
      status: 'left',
    }),
    {
      type: AppInboxType.GROUP_MEMBER_UPSERT,
      operation: 'upsertMember',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        principalId: 'charlie',
        request: { status: 'active', ...ownerActor, requestId: 'matrix-upsert' },
      } satisfies GroupMemberUpsertAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'active',
        });
      },
    },
    {
      type: AppInboxType.GROUP_OWNERSHIP_TRANSFER,
      operation: 'transferGroupOwnership',
      authority: harness.sessions.owner,
      data: {
        scope: SCOPE,
        groupId,
        request: {
          newOwnerPrincipalId: 'bob',
          ...ownerActor,
          requestId: 'matrix-transfer',
        },
      } satisfies GroupOwnershipTransferAppInboxPayload,
      assertDomain: async () => {
        const members = (await harness.repository.readSnapshot({ ...SCOPE, groupId }))?.members;
        expect(members?.find((member) => member.principalId === 'owner')?.role).toBe('admin');
        expect(members?.find((member) => member.principalId === 'bob')?.role).toBe('owner');
      },
    },
    {
      type: AppInboxType.GROUP_MEMBER_REMOVE,
      operation: 'removeGroupMember',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        principalId: 'charlie',
        request: { ...bobActor, requestId: 'matrix-remove-charlie' },
      } satisfies GroupMemberRemoveAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixMember(harness, groupId, 'charlie')).toMatchObject({
          status: 'removed',
        });
      },
    },
    {
      type: AppInboxType.GROUP_PRESENCE_CONNECT,
      operation: 'connectPresence',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: 'bob-session',
        request: {
          principalId: 'bob',
          generationId: 'matrix-generation',
          connectedAtEpochMs: harness.nowEpochMs,
          lastHeartbeatAtEpochMs: harness.nowEpochMs,
          expiresAtEpochMs: harness.nowEpochMs + 60_000,
          ...bobActor,
          requestId: 'matrix-connect',
        },
      } satisfies GroupPresenceConnectAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
          generationId: 'matrix-generation',
          status: 'active',
        });
      },
    },
    {
      type: AppInboxType.GROUP_DIRECTOR_APPOINT,
      operation: 'appointDirector',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        request: { ...bobActor, requestId: 'matrix-director' },
      } satisfies GroupDirectorAppointAppInboxPayload,
      assertDomain: async () => {
        const snapshot = await harness.repository.readSnapshot({ ...SCOPE, groupId });
        expect(snapshot?.group.metadata).toHaveProperty('rallarDirector');
      },
    },
    {
      type: AppInboxType.GROUP_PRESENCE_HEARTBEAT,
      operation: 'heartbeatPresence',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: 'bob-session',
        request: {
          principalId: 'bob',
          generationId: 'matrix-generation',
          lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000,
          expiresAtEpochMs: harness.nowEpochMs + 61_000,
          ...bobActor,
          requestId: 'matrix-heartbeat',
        },
      } satisfies GroupPresenceHeartbeatAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
          lastHeartbeatAtEpochMs: harness.nowEpochMs + 1_000,
        });
      },
    },
    {
      type: AppInboxType.GROUP_PRESENCE_DISCONNECT,
      operation: 'disconnectPresence',
      authority: harness.sessions.bob,
      data: {
        scope: SCOPE,
        groupId,
        sessionId: 'bob-session',
        request: {
          principalId: 'bob',
          generationId: 'matrix-generation',
          disconnectedAtEpochMs: harness.nowEpochMs + 2_000,
          ...bobActor,
          requestId: 'matrix-disconnect',
        },
      } satisfies GroupPresenceDisconnectAppInboxPayload,
      assertDomain: async () => {
        expect(await readMatrixPresenceSession(harness, groupId, 'bob-session')).toMatchObject({
          status: 'disconnected',
        });
      },
    },
  ];

  await runOperationMatrix(harness, groupId, cases);
}
