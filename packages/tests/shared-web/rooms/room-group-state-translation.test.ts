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
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  CreateGroupRequest,
  JoinGroupRequest,
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
      ...actor,
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
      ...actor,
      metadata: { map: 'fjord' },
      expiresAtEpochMs: 0,
      purgeAfterEpochMs: 3_000,
    });
  });

  it('retains update falsy values, omits undefined, and keeps scope outside requests', () => {
    const request = toUpdateGroupStateRequest({
      patch: {
        slug: '',
        displayName: '',
        description: '',
        kind: 'room',
        joinMode: 'open',
        maxMembers: 0,
        maxSessionsPerMember: undefined,
        metadata: { enabled: false, note: null },
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
      metadata: { enabled: false, note: null },
      expiresAtEpochMs: 0,
      ...actor,
    });
    expect(request).not.toHaveProperty('scope');
    expect(
      toJoinGroupStateRequest({
        fields: { inviteToken: 'invite-1', joinCode: 'code-1' },
        ...actor,
      }),
    ).toEqual({
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      ...actor,
    });
  });

  it('translates lifecycle and metadata operations literally', () => {
    expect(
      toRoomLifecycleGroupStateRequest({
        request: { displayName: 'Archived Room', reason: 'quiet', traceId: 'archive-trace' },
        status: 'archived',
        ...actor,
      }),
    ).toEqual({
      displayName: 'Archived Room',
      reason: 'quiet',
      traceId: 'archive-trace',
      status: 'archived',
      ...actor,
    });
    expect(
      toRoomLifecycleGroupStateRequest({
        request: { purgeAfterEpochMs: 3_000, traceId: 'delete-trace' },
        status: 'deleted',
        ...actor,
      }),
    ).toEqual({
      purgeAfterEpochMs: 3_000,
      traceId: 'delete-trace',
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
    const requests = {
      remove: { reason: 'remove', traceId: 'remove-trace' },
      ban: { reason: 'ban', traceId: 'ban-trace' },
      unban: { reason: 'unban', traceId: 'unban-trace' },
      role: { role: 'admin', reason: 'promote', traceId: 'role-trace' },
      owner: { newOwnerPrincipalId: 'member-1', reason: 'handoff', traceId: 'owner-trace' },
    } as const;
    expect(
      toCreateRoomInviteGroupStateRequest({
        request: {
          invitationExpiresAtEpochMs: 2_000,
          reason: 'join us',
          traceId: 'invite-trace',
        },
        ...actor,
      }),
    ).toEqual({
      invitationExpiresAtEpochMs: 2_000,
      reason: 'join us',
      traceId: 'invite-trace',
      ...actor,
    });
    expect(toAcceptRoomInviteGroupStateRequest(actor)).toEqual(actor);
    expect([
      toRemoveRoomMemberGroupStateRequest({ request: requests.remove, ...actor }),
      toBanRoomMemberGroupStateRequest({ request: requests.ban, ...actor }),
      toUnbanRoomMemberGroupStateRequest({ request: requests.unban, ...actor }),
      toSetRoomMemberRoleGroupStateRequest({ request: requests.role, ...actor }),
      toTransferRoomOwnershipGroupStateRequest({ request: requests.owner, ...actor }),
    ]).toEqual([
      { reason: 'remove', traceId: 'remove-trace', ...actor },
      { reason: 'ban', traceId: 'ban-trace', ...actor },
      { reason: 'unban', traceId: 'unban-trace', ...actor },
      { role: 'admin', reason: 'promote', traceId: 'role-trace', ...actor },
      {
        newOwnerPrincipalId: 'member-1',
        reason: 'handoff',
        traceId: 'owner-trace',
        ...actor,
      },
    ]);
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
    const selectedSummary = {
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
    } as const;
    expect(summary).toEqual(selectedSummary);
    expect(summary.snapshot).toBe(selected);

    const state = toRallarRoomState({
      snapshots: [selected, archived, alpha],
      clients: [bob, alice],
      sessionId: 'session-1',
      currentRoomRef: selected.group,
    });
    expect(state.rooms).toEqual([
      {
        roomId: 'alpha',
        roomRef: alpha.group,
        name: 'Alpha Room',
        status: 'active',
        kind: 'room',
        joinMode: 'open',
        memberCount: 1,
        onlineMemberCount: 0,
        isJoined: false,
        isCurrent: false,
        snapshot: alpha,
      },
      selectedSummary,
    ]);
    expect(state.rooms[0]?.snapshot).toBe(alpha);
    expect(state.rooms[1]?.snapshot).toBe(selected);
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
        sessionIds: ['session-1', 'session-2'],
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
  const member = (principalId: string, role: 'owner' | 'member') =>
    createActiveGroupMemberFixture({ ...scope, principalId, role, actorPrincipalId: 'alice' });
  const presence = (sessionId: string) =>
    createActiveGroupPresenceSessionFixture({ ...scope, principalId: 'alice', sessionId });
  return {
    ...snapshot,
    group: { ...snapshot.group, ownerPrincipalId: 'alice', activeMemberCount: 2 },
    members: [member('alice', 'owner'), member('bob', 'member')],
    activeSessions: [presence('session-1'), presence('session-2')],
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
