import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  toAcceptRoomInviteGroupStateRequest,
  toBanRoomMemberGroupStateRequest,
  toConnectRoomPresenceGroupStateRequest,
  toCreateGroupStateRequest,
  toCreateRoomInviteGroupStateRequest,
  toDisconnectRoomPresenceGroupStateRequest,
  toJoinGroupStateRequest,
  toLeaveRoomMemberGroupStateRequest,
  toRemoveRoomMemberGroupStateRequest,
  toRallarRoomState,
  toRallarRoomSummary,
  toRoomLifecycleGroupStateRequest,
  toRoomMetadataGroupStateRequest,
  toSetRoomMemberRoleGroupStateRequest,
  toTransferRoomOwnershipGroupStateRequest,
  toUnbanRoomMemberGroupStateRequest,
  toUpdateGroupStateRequest,
  type RoomCreateGroupStateFields,
  type RoomJoinGroupStateFields,
} from '@shared-web/browser/rooms/room-group-state-translation.ts';
import type {
  RallarCreateRoomInput,
  RallarJoinRoomOptions,
  RallarRoomState,
  RallarUpdateRoomInput,
} from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupMember, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  CreateGroupRequest,
  JoinGroupRequest,
  StateScope,
  UpdateGroupRequest,
} from '@shared/api/state-types.ts';

import {
  createActiveGroupMemberFixture,
  createActiveGroupPresenceSessionFixture,
  createClientSnapshotFixture,
  createGroupSnapshotFixture,
} from '../authoritative-group-fixtures.ts';

const actor = {
  actorPrincipalId: 'owner-1',
  actorSessionId: 'owner-session',
  requestId: 'request-1',
} as const;

describe('room to authoritative group-state translation', () => {
  it('translates minimal and fully populated create fields with literal defaults', () => {
    expect(
      toCreateGroupStateRequest({
        groupId: 'room-1',
        fields: { displayName: 'My Room' },
        createdByPrincipalId: 'owner-1',
        ...actor,
      }),
    ).toEqual({
      groupId: 'room-1',
      slug: 'my-room',
      displayName: 'My Room',
      kind: 'room',
      joinMode: 'invite-only',
      createdByPrincipalId: 'owner-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'request-1',
      metadata: {},
    });

    expect(
      toCreateGroupStateRequest({
        groupId: 'room-2',
        fields: {
          displayName: ' Fjord & Fire ',
          description: '',
          joinMode: 'open',
          maxMembers: 0,
          maxSessionsPerMember: 2,
          metadata: { map: 'fjord' },
          expiresAtEpochMs: 0,
          purgeAfterEpochMs: 3_000,
        },
        createdByPrincipalId: 'owner-1',
        ...actor,
      }),
    ).toEqual({
      groupId: 'room-2',
      slug: 'fjord-fire',
      displayName: ' Fjord & Fire ',
      description: '',
      kind: 'room',
      joinMode: 'open',
      maxMembers: 0,
      maxSessionsPerMember: 2,
      createdByPrincipalId: 'owner-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'request-1',
      metadata: { map: 'fjord' },
      expiresAtEpochMs: 0,
      purgeAfterEpochMs: 3_000,
    });
  });

  it('retains update falsy values, omits undefined, and keeps scope outside requests', () => {
    const scope: StateScope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
    const request = toUpdateGroupStateRequest({
      patch: {
        slug: '',
        displayName: '',
        description: '',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 0,
        maxSessionsPerMember: undefined,
        metadata: {},
        expiresAtEpochMs: 0,
        purgeAfterEpochMs: undefined,
      },
      ...actor,
    });

    expect(request).toEqual({
      slug: '',
      displayName: '',
      description: '',
      kind: 'room',
      joinMode: 'open',
      maxMembers: 0,
      metadata: {},
      expiresAtEpochMs: 0,
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'request-1',
    });
    expect(request).not.toHaveProperty('scope');
    expect(scope).toEqual({ applicationId: 'app-1', workspaceId: 'workspace-1' });
    expect(
      toJoinGroupStateRequest({
        fields: { inviteToken: 'invite-1', joinCode: 'code-1' },
        ...actor,
      }),
    ).toEqual({
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      actorPrincipalId: 'owner-1',
      actorSessionId: 'owner-session',
      requestId: 'request-1',
    });
  });

  it('translates lifecycle and metadata operations literally', () => {
    expect(
      toRoomLifecycleGroupStateRequest({ status: 'archived', reason: 'quiet', ...actor }),
    ).toEqual({ status: 'archived', reason: 'quiet', ...actor });
    expect(toRoomLifecycleGroupStateRequest({ status: 'deleted', ...actor })).toEqual({
      status: 'deleted',
      ...actor,
    });
    expect(
      toRoomMetadataGroupStateRequest({
        currentMetadata: { keep: true, replace: 'old' },
        patch: { replace: 'new', empty: '' },
        ...actor,
      }),
    ).toEqual({
      metadata: { keep: true, replace: 'new', empty: '' },
      ...actor,
    });
  });

  it('translates every invite and member-governance request', () => {
    expect(
      toCreateRoomInviteGroupStateRequest({
        invitationExpiresAtEpochMs: 2_000,
        reason: 'join us',
        ...actor,
      }),
    ).toEqual({ invitationExpiresAtEpochMs: 2_000, reason: 'join us', ...actor });
    expect(toAcceptRoomInviteGroupStateRequest(actor)).toEqual(actor);
    expect(toRemoveRoomMemberGroupStateRequest({ reason: 'remove', ...actor })).toEqual({
      reason: 'remove',
      ...actor,
    });
    expect(toBanRoomMemberGroupStateRequest({ reason: 'ban', ...actor })).toEqual({
      reason: 'ban',
      ...actor,
    });
    expect(toUnbanRoomMemberGroupStateRequest({ reason: 'unban', ...actor })).toEqual({
      reason: 'unban',
      ...actor,
    });
    expect(
      toSetRoomMemberRoleGroupStateRequest({ role: 'admin', reason: 'promote', ...actor }),
    ).toEqual({ role: 'admin', reason: 'promote', ...actor });
    expect(
      toTransferRoomOwnershipGroupStateRequest({
        newOwnerPrincipalId: 'member-1',
        reason: 'handoff',
        ...actor,
      }),
    ).toEqual({ newOwnerPrincipalId: 'member-1', reason: 'handoff', ...actor });
  });

  it('translates presence and leave requests with stable captured IDs', () => {
    const presence = {
      principalId: 'member-1',
      generationId: 'generation-1',
      ...actor,
    } as const;

    expect(toConnectRoomPresenceGroupStateRequest(presence)).toEqual(presence);
    expect(toDisconnectRoomPresenceGroupStateRequest(presence)).toEqual({
      ...presence,
      reason: 'left-group',
    });
    expect(toLeaveRoomMemberGroupStateRequest(actor)).toEqual({
      status: 'left',
      reason: 'left-group',
      ...actor,
    });
  });

  it('projects active summaries, current selection, ordered members, and snapshot identity', () => {
    const alpha = createRoomSnapshot('alpha', 'Alpha Room', []);
    const selected = createSelectedRoomSnapshot();
    const archivedBase = createRoomSnapshot('archived', 'Archived Room', []);
    const archived: GroupSnapshot = {
      ...archivedBase,
      group: {
        ...archivedBase.group,
        status: 'archived',
        archived: archivedBase.group.updated,
        deleted: null,
      },
    };
    const alice = createClient('alice', 'Zulu Display', 'alice');
    const bob = createClient('bob', null, 'Alpha Username');

    const summary = toRallarRoomSummary({
      snapshot: selected,
      sessionId: 'session-1',
      currentRoomRef: selected.group,
    });
    expect(summary).toEqual({
      roomId: 'selected',
      roomRef: selected.group,
      name: 'Beta Room',
      status: 'active',
      kind: 'room',
      joinMode: 'open',
      memberCount: 2,
      onlineMemberCount: 1,
      isJoined: true,
      isCurrent: true,
      snapshot: selected,
    });
    expect(summary.snapshot).toBe(selected);

    const state = toRallarRoomState({
      snapshots: [selected, archived, alpha],
      clients: [bob, alice],
      sessionId: 'session-1',
      currentRoomRef: selected.group,
    });
    expect(state.rooms.map((room) => room.roomId)).toEqual(['alpha', 'selected']);
    expect(state.currentRoomId).toBe('selected');
    expect(state.currentRoomRef).toBe(selected.group);
    expect(state.currentRoom).toBe(selected);
    expect(state.members).toEqual([
      {
        principalId: 'bob',
        username: 'Alpha Username',
        displayName: undefined,
        role: 'member',
        status: 'active',
        isOwner: false,
        isOnline: false,
        sessionIds: [],
        client: bob,
      },
      {
        principalId: 'alice',
        username: 'alice',
        displayName: 'Zulu Display',
        role: 'owner',
        status: 'active',
        isOwner: true,
        isOnline: true,
        sessionIds: ['session-1'],
        client: alice,
      },
    ]);
  });

  it('retains facade inputs and authoritative request result types', () => {
    expectTypeOf<RallarCreateRoomInput>().toMatchTypeOf<RoomCreateGroupStateFields>();
    expectTypeOf<RallarUpdateRoomInput>().toMatchTypeOf<UpdateGroupRequest>();
    expectTypeOf<RallarJoinRoomOptions>().toMatchTypeOf<RoomJoinGroupStateFields>();
    expectTypeOf(toCreateGroupStateRequest).returns.toEqualTypeOf<CreateGroupRequest>();
    expectTypeOf(toUpdateGroupStateRequest).returns.toEqualTypeOf<UpdateGroupRequest>();
    expectTypeOf(toJoinGroupStateRequest).returns.toEqualTypeOf<JoinGroupRequest>();
    expectTypeOf(toRallarRoomState).returns.toEqualTypeOf<RallarRoomState>();
  });
});

function createRoomSnapshot(
  groupId: string,
  displayName: string,
  sessionIds: readonly string[],
): GroupSnapshot {
  const snapshot = createGroupSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId,
    sessionIds,
  });
  return { ...snapshot, group: { ...snapshot.group, displayName } };
}

function createSelectedRoomSnapshot(): GroupSnapshot {
  const snapshot = createRoomSnapshot('selected', 'Beta Room', []);
  const scope = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'selected' };
  const members: readonly GroupMember[] = [
    createActiveGroupMemberFixture({
      ...scope,
      principalId: 'alice',
      role: 'owner',
      actorPrincipalId: 'alice',
    }),
    createActiveGroupMemberFixture({
      ...scope,
      principalId: 'bob',
      role: 'member',
      actorPrincipalId: 'alice',
    }),
  ];
  return {
    ...snapshot,
    group: { ...snapshot.group, ownerPrincipalId: 'alice', activeMemberCount: 2 },
    members,
    activeSessions: [
      createActiveGroupPresenceSessionFixture({
        ...scope,
        principalId: 'alice',
        sessionId: 'session-1',
      }),
    ],
    memberCount: 2,
    onlineMemberCount: 1,
  };
}

function createClient(
  principalId: string,
  displayName: string | null,
  username: string,
): ClientSnapshot {
  const snapshot = createClientSnapshotFixture({
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    principalId,
  });
  return {
    ...snapshot,
    principal: { ...snapshot.principal, username, displayName },
  };
}
