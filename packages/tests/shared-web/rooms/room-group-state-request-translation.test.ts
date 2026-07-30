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
  RallarUpdateRoomInput,
} from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type {
  CreateGroupRequest,
  JoinGroupRequest,
  UpdateGroupRequest,
} from '@shared/api/state-types.ts';

const actor = {
  actorPrincipalId: 'owner-1',
  actorSessionId: 'owner-session',
  requestId: 'request-1',
} as const;

describe('room request translation', () => {
  it('translates minimal and fully populated create fields with literal defaults', () => {
    expect(
      toCreateGroupStateRequest({
        groupId: 'room-1',
        room: { displayName: 'My Room' },
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
        room: {
          displayName: ' Fjord & Fire ',
          description: '',
          joinMode: 'open',
          maxMembers: 0,
          maxSessionsPerMember: 2,
          metadata: { map: 'fjord' },
          expiresAtEpochMs: 0,
          purgeAfterEpochMs: 3_000,
        },
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
      request: {
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
        room: { inviteToken: 'invite-1', joinCode: 'code-1' },
        ...actor,
      }),
    ).toEqual({
      inviteToken: 'invite-1',
      joinCode: 'code-1',
      ...actor,
    });
  });

  it('preserves literal raw JSON omission and insertion order for create, join, and update', () => {
    expect(
      JSON.stringify(
        toCreateGroupStateRequest({
          groupId: 'ordered-room',
          room: {
            displayName: 'Ordered Room',
            description: undefined,
            maxMembers: 0,
            expiresAtEpochMs: undefined,
          },
          ...actor,
        }),
      ),
    ).toBe(
      '{"groupId":"ordered-room","slug":"ordered-room","displayName":"Ordered Room","kind":"room","joinMode":"invite-only","maxMembers":0,"createdByPrincipalId":"owner-1","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1","metadata":{}}',
    );
    expect(
      JSON.stringify(
        toJoinGroupStateRequest({
          room: { inviteToken: undefined, joinCode: '' },
          ...actor,
        }),
      ),
    ).toBe(
      '{"joinCode":"","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(
      JSON.stringify(
        toUpdateGroupStateRequest({
          request: {
            traceId: 'caller-trace',
            actorPrincipalId: 'caller-owner',
            maxMembers: 0,
            maxSessionsPerMember: undefined,
            actorSessionId: 'caller-session',
            requestId: 'caller-request',
            metadata: { sawNull: null },
          },
          ...actor,
        }),
      ),
    ).toBe(
      '{"traceId":"caller-trace","actorPrincipalId":"owner-1","maxMembers":0,"actorSessionId":"owner-session","requestId":"request-1","metadata":{"sawNull":null}}',
    );
  });

  it('omits undefined own properties in lifecycle, invite, and member-governance requests', () => {
    const lifecycle = toRoomLifecycleGroupStateRequest({
      request: {
        traceId: 'lifecycle-trace',
        maxMembers: 0,
        purgeAfterEpochMs: undefined,
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      status: 'archived',
      ...actor,
    });
    const invite = toCreateRoomInviteGroupStateRequest({
      request: {
        invitationExpiresAtEpochMs: 0,
        reason: undefined,
        traceId: 'invite-trace',
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });
    const remove = toRemoveRoomMemberGroupStateRequest({
      request: {
        reason: undefined,
        traceId: 'remove-trace',
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });
    const ban = toBanRoomMemberGroupStateRequest({
      request: {
        reason: '',
        traceId: undefined,
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });
    const unban = toUnbanRoomMemberGroupStateRequest({
      request: {
        reason: undefined,
        traceId: 'unban-trace',
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });
    const role = toSetRoomMemberRoleGroupStateRequest({
      request: {
        role: 'admin',
        reason: undefined,
        traceId: 'role-trace',
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });
    const ownership = toTransferRoomOwnershipGroupStateRequest({
      request: {
        newOwnerPrincipalId: 'member-1',
        reason: undefined,
        traceId: 'owner-trace',
        actorPrincipalId: 'caller-owner',
        actorSessionId: 'caller-session',
        requestId: 'caller-request',
      },
      ...actor,
    });

    expect(lifecycle).not.toHaveProperty('purgeAfterEpochMs');
    expect(invite).not.toHaveProperty('reason');
    expect(remove).not.toHaveProperty('reason');
    expect(ban).not.toHaveProperty('traceId');
    expect(unban).not.toHaveProperty('reason');
    expect(role).not.toHaveProperty('reason');
    expect(ownership).not.toHaveProperty('reason');
    expect(JSON.stringify(lifecycle)).toBe(
      '{"traceId":"lifecycle-trace","maxMembers":0,"actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1","status":"archived"}',
    );
    expect(JSON.stringify(invite)).toBe(
      '{"invitationExpiresAtEpochMs":0,"traceId":"invite-trace","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(JSON.stringify(remove)).toBe(
      '{"traceId":"remove-trace","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(JSON.stringify(ban)).toBe(
      '{"reason":"","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(JSON.stringify(unban)).toBe(
      '{"traceId":"unban-trace","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(JSON.stringify(role)).toBe(
      '{"role":"admin","traceId":"role-trace","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
    expect(JSON.stringify(ownership)).toBe(
      '{"newOwnerPrincipalId":"member-1","traceId":"owner-trace","actorPrincipalId":"owner-1","actorSessionId":"owner-session","requestId":"request-1"}',
    );
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

  it('retains facade inputs and authoritative request result types', () => {
    expectTypeOf<RallarCreateRoomInput>().toMatchTypeOf<RoomCreateGroupStateFields>();
    expectTypeOf<RallarUpdateRoomInput>().toMatchTypeOf<UpdateGroupRequest>();
    expectTypeOf<RallarJoinRoomOptions>().toMatchTypeOf<RoomJoinGroupStateFields>();
    expectTypeOf(toCreateGroupStateRequest).returns.toEqualTypeOf<CreateGroupRequest>();
    expectTypeOf(toUpdateGroupStateRequest).returns.toEqualTypeOf<UpdateGroupRequest>();
    expectTypeOf(toJoinGroupStateRequest).returns.toEqualTypeOf<JoinGroupRequest>();
  });
});
