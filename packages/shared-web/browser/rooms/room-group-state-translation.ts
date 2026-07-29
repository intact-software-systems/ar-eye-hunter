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
  RallarUpdateRoomInput,
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

export type RoomUpdateGroupStateFields = Pick<
  RallarUpdateRoomInput,
  | 'slug'
  | 'displayName'
  | 'description'
  | 'kind'
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

interface RoomGroupStateActorInput {
  readonly actorPrincipalId: string;
  readonly actorSessionId: string;
  readonly requestId: string;
}

interface RoomGroupStateRequestInput<TRequest> extends RoomGroupStateActorInput {
  readonly request: TRequest;
}

export interface ToCreateGroupStateRequestInput extends RoomGroupStateActorInput {
  readonly groupId: string;
  readonly fields: RoomCreateGroupStateFields;
  readonly createdByPrincipalId: string;
}

export interface ToUpdateGroupStateRequestInput extends RoomGroupStateActorInput {
  readonly patch: UpdateGroupRequest;
}

export interface ToJoinGroupStateRequestInput extends RoomGroupStateActorInput {
  readonly fields: RoomJoinGroupStateFields;
}

export interface ToRoomLifecycleGroupStateRequestInput extends RoomGroupStateRequestInput<
  Omit<UpdateGroupRequest, 'status'>
> {
  readonly status: 'archived' | 'deleted';
}

export interface ToRoomMetadataGroupStateRequestInput extends RoomGroupStateActorInput {
  readonly currentMetadata: Readonly<Record<string, unknown>>;
  readonly patch: Readonly<Record<string, unknown>>;
}

export type ToCreateRoomInviteGroupStateRequestInput =
  RoomGroupStateRequestInput<CreateGroupInviteRequest>;

export type ToAcceptRoomInviteGroupStateRequestInput = RoomGroupStateActorInput;
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

export interface ToRoomPresenceGroupStateRequestInput extends RoomGroupStateActorInput {
  readonly principalId: string;
  readonly generationId: string;
}

export type ToConnectRoomPresenceGroupStateRequestInput = ToRoomPresenceGroupStateRequestInput;
export type ToDisconnectRoomPresenceGroupStateRequestInput = ToRoomPresenceGroupStateRequestInput;
export type ToLeaveRoomMemberGroupStateRequestInput = RoomGroupStateActorInput;

export interface ToRallarRoomSummaryInput {
  readonly snapshot: GroupSnapshot;
  readonly sessionId?: string;
  readonly currentRoomRef?: GroupRef;
}

export interface ToRallarRoomStateInput {
  readonly snapshots: readonly GroupSnapshot[];
  readonly clients: readonly ClientSnapshot[];
  readonly sessionId?: string;
  readonly currentRoomRef?: GroupRef;
}

export function toCreateGroupStateRequest(
  input: ToCreateGroupStateRequestInput,
): CreateGroupRequest {
  return toDefinedRecord({
    groupId: input.groupId,
    slug: toRoomGroupStateSlug(input.fields.displayName),
    displayName: input.fields.displayName,
    kind: 'room' as const,
    description: input.fields.description,
    joinMode: input.fields.joinMode ?? 'invite-only',
    maxMembers: input.fields.maxMembers,
    maxSessionsPerMember: input.fields.maxSessionsPerMember,
    createdByPrincipalId: input.createdByPrincipalId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    requestId: input.requestId,
    metadata: input.fields.metadata ?? {},
    expiresAtEpochMs: input.fields.expiresAtEpochMs,
    purgeAfterEpochMs: input.fields.purgeAfterEpochMs,
  });
}

export function toUpdateGroupStateRequest(
  input: ToUpdateGroupStateRequestInput,
): UpdateGroupRequest {
  return toDefinedRecord({
    ...input.patch,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    requestId: input.requestId,
  });
}

export function toJoinGroupStateRequest(input: ToJoinGroupStateRequestInput): JoinGroupRequest {
  return toDefinedRecord({ ...input.fields, ...toActorRequest(input) });
}

export function toRoomLifecycleGroupStateRequest(
  input: ToRoomLifecycleGroupStateRequestInput,
): UpdateGroupRequest {
  return toDefinedRecord({
    ...input.request,
    status: input.status,
    ...toActorRequest(input),
  });
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
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
}

export function toAcceptRoomInviteGroupStateRequest(
  input: ToAcceptRoomInviteGroupStateRequestInput,
): AcceptGroupInviteRequest {
  return toActorRequest(input);
}

export function toRemoveRoomMemberGroupStateRequest(
  input: ToRemoveRoomMemberGroupStateRequestInput,
): RemoveGroupMemberRequest {
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
}

export function toBanRoomMemberGroupStateRequest(
  input: ToBanRoomMemberGroupStateRequestInput,
): BanGroupMemberRequest {
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
}

export function toUnbanRoomMemberGroupStateRequest(
  input: ToUnbanRoomMemberGroupStateRequestInput,
): UnbanGroupMemberRequest {
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
}

export function toSetRoomMemberRoleGroupStateRequest(
  input: ToSetRoomMemberRoleGroupStateRequestInput,
): SetGroupMemberRoleRequest {
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
}

export function toTransferRoomOwnershipGroupStateRequest(
  input: ToTransferRoomOwnershipGroupStateRequestInput,
): TransferGroupOwnershipRequest {
  return toDefinedRecord({ ...input.request, ...toActorRequest(input) });
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
  input: ToLeaveRoomMemberGroupStateRequestInput,
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
  const snapshots = input.snapshots
    .filter(isGroupActive)
    .sort((left, right) => readGroupDisplayName(left).localeCompare(readGroupDisplayName(right)));
  const currentRoom = input.currentRoomRef
    ? snapshots.find((snapshot) => isSameGroupRef(snapshot.group, input.currentRoomRef!))
    : undefined;

  return {
    rooms: snapshots.map((snapshot) =>
      toRallarRoomSummary({
        snapshot,
        sessionId: input.sessionId,
        currentRoomRef: input.currentRoomRef,
      }),
    ),
    currentRoomId: input.currentRoomRef?.groupId,
    currentRoomRef: input.currentRoomRef,
    currentRoom,
    members: toRallarRoomMembers(currentRoom, input.clients),
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
        (candidate) =>
          candidate.principal.applicationId === member.applicationId &&
          candidate.principal.workspaceId === member.workspaceId &&
          candidate.principal.principalId === member.principalId,
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
}: RoomGroupStateActorInput): RoomGroupStateActorInput {
  return {
    actorPrincipalId,
    actorSessionId,
    requestId,
  };
}

function toDefinedRecord<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function toRoomGroupStateSlug(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
