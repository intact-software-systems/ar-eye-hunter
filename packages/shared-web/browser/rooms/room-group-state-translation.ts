import type { ClientSnapshot } from '@shared/api/client-types.ts';
import {
  isGroupActive,
  isSessionInGroup,
  readGroupDisplayName,
  readGroupId,
} from '@shared/api/group-client-views.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type {
  AcceptGroupInviteRequest,
  BanGroupMemberRequest,
  ConnectGroupPresenceSessionRequest,
  CreateGroupInviteRequest,
  CreateGroupRequest,
  DisconnectGroupPresenceSessionRequest,
  JoinGroupRequest,
  RemoveGroupMemberRequest,
  SetGroupMemberRoleRequest,
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';

import type {
  RallarCreateRoomInput,
  RallarRoomState,
  RallarRoomSummary,
} from './rallar-room-contracts.ts';

export type {
  GroupEvent,
  GroupEventType,
  GroupJoinMode,
  GroupMemberStatus,
  GroupRef,
  GroupRole,
  GroupSnapshot,
  GroupStatus,
} from '@shared/api/group-types.ts';
export type { StateEventCursor, StateEventPage } from '@shared/api/state-event-types.ts';
export type {
  AcceptGroupInviteRequest,
  BanGroupMemberRequest,
  ConnectGroupPresenceSessionRequest,
  CreateGroupInviteRequest,
  CreateGroupRequest,
  DisconnectGroupPresenceSessionRequest,
  JoinGroupRequest,
  RemoveGroupMemberRequest,
  SetGroupMemberRoleRequest,
  StateScope,
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';

export type RoomCreateGroupStateFields = Pick<
  RallarCreateRoomInput,
  | 'displayName'
  | 'description'
  | 'joinMode'
  | 'maxMembers'
  | 'maxSessionsPerMember'
  | 'metadata'
  | 'expiresAtEpochMs'
  | 'purgeAfterEpochMs'
>;

export interface RoomJoinGroupStateFields {
  readonly inviteToken?: string;
  readonly joinCode?: string;
}

interface RoomGroupStateMutationActorInput {
  readonly actorPrincipalId: string;
  readonly actorSessionId: string;
  readonly requestId: string;
}
interface RoomGroupStateRequestInput<TRequest> extends RoomGroupStateMutationActorInput {
  readonly request: TRequest;
}
export interface ToCreateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly groupId: string;
  readonly room: RoomCreateGroupStateFields;
}
export interface ToUpdateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly request: UpdateGroupRequest;
}
export interface ToJoinGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly room: RoomJoinGroupStateFields;
}
export interface ToRoomLifecycleGroupStateRequestInput extends RoomGroupStateRequestInput<
  Omit<UpdateGroupRequest, 'status'>
> {
  readonly status: 'archived' | 'deleted';
}
export interface ToRoomMetadataGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly currentMetadata: Readonly<Record<string, unknown>>;
  readonly patch: Readonly<Record<string, unknown>>;
}
export type ToCreateRoomInviteGroupStateRequestInput =
  RoomGroupStateRequestInput<CreateGroupInviteRequest>;
export type ToRemoveRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<RemoveGroupMemberRequest>;
export type ToBanRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<BanGroupMemberRequest>;
export type ToUnbanRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<UnbanGroupMemberRequest>;
export type ToSetRoomMemberRoleGroupStateRequestInput =
  RoomGroupStateRequestInput<SetGroupMemberRoleRequest>;
export type ToTransferRoomOwnershipGroupStateRequestInput =
  RoomGroupStateRequestInput<TransferGroupOwnershipRequest>;

interface RoomPresenceGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly principalId: string;
  readonly generationId: string;
}

export type ToConnectRoomPresenceGroupStateRequestInput = RoomPresenceGroupStateRequestInput;
export type ToDisconnectRoomPresenceGroupStateRequestInput = RoomPresenceGroupStateRequestInput;

export interface ToRallarRoomSummaryInput {
  readonly snapshot: GroupSnapshot;
  readonly sessionId?: string;
  readonly currentRoomRef?: GroupRef;
}

export interface ToRallarRoomStateInput {
  readonly groupSnapshots: readonly GroupSnapshot[];
  readonly clientSnapshots: readonly ClientSnapshot[];
  readonly sessionId?: string;
  readonly currentRoomRef?: GroupRef;
  readonly currentRoom?: GroupSnapshot;
}

export function toCreateGroupStateRequest(
  input: ToCreateGroupStateRequestInput,
): CreateGroupRequest {
  const { room } = input;
  return {
    groupId: input.groupId,
    slug: toRoomGroupStateSlug(room.displayName),
    displayName: room.displayName,
    kind: 'room' as const,
    ...(room.description === undefined ? {} : { description: room.description }),
    joinMode: room.joinMode ?? 'invite-only',
    ...(room.maxMembers === undefined ? {} : { maxMembers: room.maxMembers }),
    ...(room.maxSessionsPerMember === undefined
      ? {}
      : { maxSessionsPerMember: room.maxSessionsPerMember }),
    createdByPrincipalId: input.actorPrincipalId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    requestId: input.requestId,
    metadata: room.metadata ?? {},
    ...(room.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: room.expiresAtEpochMs }),
    ...(room.purgeAfterEpochMs === undefined ? {} : { purgeAfterEpochMs: room.purgeAfterEpochMs }),
  };
}

export function toUpdateGroupStateRequest(
  input: ToUpdateGroupStateRequestInput,
): UpdateGroupRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as UpdateGroupRequest;
}

export function toJoinGroupStateRequest(input: ToJoinGroupStateRequestInput): JoinGroupRequest {
  return {
    ...(input.room.inviteToken === undefined ? {} : { inviteToken: input.room.inviteToken }),
    ...(input.room.joinCode === undefined ? {} : { joinCode: input.room.joinCode }),
    ...toActorRequest(input),
  };
}

export function toRoomLifecycleGroupStateRequest(
  input: ToRoomLifecycleGroupStateRequestInput,
): UpdateGroupRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, status: input.status, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as UpdateGroupRequest;
}

export function toRoomMetadataGroupStateRequest(
  input: ToRoomMetadataGroupStateRequestInput,
): UpdateGroupRequest {
  return {
    metadata: { ...input.currentMetadata, ...input.patch },
    ...toActorRequest(input),
  };
}

export function toCreateRoomInviteGroupStateRequest(
  input: ToCreateRoomInviteGroupStateRequestInput,
): CreateGroupInviteRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as CreateGroupInviteRequest;
}

export function toAcceptRoomInviteGroupStateRequest(
  input: RoomGroupStateMutationActorInput,
): AcceptGroupInviteRequest {
  return toActorRequest(input);
}

export function toRemoveRoomMemberGroupStateRequest(
  input: ToRemoveRoomMemberGroupStateRequestInput,
): RemoveGroupMemberRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as RemoveGroupMemberRequest;
}

export function toBanRoomMemberGroupStateRequest(
  input: ToBanRoomMemberGroupStateRequestInput,
): BanGroupMemberRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as BanGroupMemberRequest;
}

export function toUnbanRoomMemberGroupStateRequest(
  input: ToUnbanRoomMemberGroupStateRequestInput,
): UnbanGroupMemberRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as UnbanGroupMemberRequest;
}

export function toSetRoomMemberRoleGroupStateRequest(
  input: ToSetRoomMemberRoleGroupStateRequestInput,
): SetGroupMemberRoleRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as SetGroupMemberRoleRequest;
}

export function toTransferRoomOwnershipGroupStateRequest(
  input: ToTransferRoomOwnershipGroupStateRequestInput,
): TransferGroupOwnershipRequest {
  return Object.fromEntries(
    Object.entries({ ...input.request, ...toActorRequest(input) }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as TransferGroupOwnershipRequest;
}

export function toConnectRoomPresenceGroupStateRequest(
  input: ToConnectRoomPresenceGroupStateRequestInput,
): ConnectGroupPresenceSessionRequest {
  return {
    principalId: input.principalId,
    generationId: input.generationId,
    ...toActorRequest(input),
  };
}

export function toDisconnectRoomPresenceGroupStateRequest(
  input: ToDisconnectRoomPresenceGroupStateRequestInput,
): DisconnectGroupPresenceSessionRequest {
  return {
    generationId: input.generationId,
    principalId: input.principalId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    reason: 'left-group',
    requestId: input.requestId,
  };
}

export function toLeaveRoomMemberGroupStateRequest(
  input: RoomGroupStateMutationActorInput,
): UpsertGroupMemberRequest {
  return {
    status: 'left',
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    reason: 'left-group',
    requestId: input.requestId,
  };
}

export function toRallarRoomSummary(input: ToRallarRoomSummaryInput): RallarRoomSummary {
  return {
    roomId: readGroupId(input.snapshot),
    roomRef: input.snapshot.group,
    name: readGroupDisplayName(input.snapshot),
    status: input.snapshot.group.status,
    kind: input.snapshot.group.kind,
    joinMode: input.snapshot.group.joinMode,
    memberCount: input.snapshot.memberCount,
    onlineMemberCount: input.snapshot.onlineMemberCount,
    isJoined: input.sessionId ? isSessionInGroup(input.snapshot, input.sessionId) : false,
    isCurrent: input.currentRoomRef
      ? isSameGroupRef(input.snapshot.group, input.currentRoomRef)
      : false,
    snapshot: input.snapshot,
  };
}

export function toRallarRoomState(input: ToRallarRoomStateInput): RallarRoomState {
  const groupSnapshots = input.groupSnapshots
    .filter(isGroupActive)
    .sort((left, right) => readGroupDisplayName(left).localeCompare(readGroupDisplayName(right)));

  return {
    rooms: groupSnapshots.map((snapshot) =>
      toRallarRoomSummary({
        snapshot,
        sessionId: input.sessionId,
        currentRoomRef: input.currentRoomRef,
      }),
    ),
    currentRoomId: input.currentRoomRef?.groupId,
    currentRoomRef: input.currentRoomRef,
    currentRoom: input.currentRoom,
    members: toRallarRoomMembers(input.currentRoom, input.clientSnapshots),
  };
}

function toRallarRoomMembers(
  currentRoom: GroupSnapshot | undefined,
  clients: readonly ClientSnapshot[],
): RallarRoomState['members'] {
  if (!currentRoom) {
    return [];
  }
  const sessionIdsByPrincipalId = new Map<string, string[]>();
  for (const session of currentRoom.activeSessions) {
    const sessionIds = sessionIdsByPrincipalId.get(session.principalId) ?? [];
    sessionIds.push(session.sessionId);
    sessionIdsByPrincipalId.set(session.principalId, sessionIds);
  }
  return currentRoom.members
    .map((member) => {
      const client = clients.find(
        (candidate) => candidate.principal.principalId === member.principalId,
      );
      const sessionIds = sessionIdsByPrincipalId.get(member.principalId) ?? [];
      return {
        principalId: member.principalId,
        username: client?.principal.username ?? member.principalId,
        displayName: client?.principal.displayName ?? undefined,
        role: member.role,
        status: member.status,
        isOwner: member.role === 'owner',
        isOnline: sessionIds.length > 0,
        sessionIds,
        client,
      };
    })
    .sort((left, right) =>
      (left.displayName ?? left.username).localeCompare(right.displayName ?? right.username),
    );
}

function toActorRequest({
  actorPrincipalId,
  actorSessionId,
  requestId,
}: RoomGroupStateMutationActorInput): RoomGroupStateMutationActorInput {
  return {
    actorPrincipalId,
    actorSessionId,
    requestId,
  };
}

function toRoomGroupStateSlug(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
