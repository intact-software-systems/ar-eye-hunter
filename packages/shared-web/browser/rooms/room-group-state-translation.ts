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
  AcceptStateGroupInviteBody,
  BanStateGroupMemberBody,
  ConnectStateGroupPresenceSessionBody,
  CreateStateGroupBody,
  CreateStateGroupInviteBody,
  DisconnectStateGroupPresenceSessionBody,
  JoinStateGroupBody,
  RemoveStateGroupMemberBody,
  SetStateGroupMemberRoleBody,
  TransferStateGroupOwnershipBody,
  UnbanStateGroupMemberBody,
  UpdateStateGroupBody,
  UpsertStateGroupMemberBody,
} from '../api/state-mutation-http-contracts.ts';

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
export type { StateScope } from '@shared/api/state-types.ts';
export type {
  BanStateGroupMemberBody,
  CreateStateGroupBody,
  CreateStateGroupInviteBody,
  RemoveStateGroupMemberBody,
  SetStateGroupMemberRoleBody,
  TransferStateGroupOwnershipBody,
  UnbanStateGroupMemberBody,
  UpdateStateGroupBody,
} from '../api/state-mutation-http-contracts.ts';

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
}
interface RoomGroupStateRequestInput<TRequest> extends RoomGroupStateMutationActorInput {
  readonly request: TRequest;
}
export interface ToCreateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly groupId: string;
  readonly room: RoomCreateGroupStateFields;
}
export interface ToUpdateGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly request: UpdateStateGroupBody;
}
export interface ToJoinGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly room: RoomJoinGroupStateFields;
}
export interface ToRoomLifecycleGroupStateRequestInput extends RoomGroupStateRequestInput<
  Omit<UpdateStateGroupBody, 'status'>
> {
  readonly status: 'archived' | 'deleted';
}
export interface ToRoomMetadataGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly currentMetadata: Readonly<Record<string, unknown>>;
  readonly patch: Readonly<Record<string, unknown>>;
}
interface RoomGroupStateMutationAuditFields {
  readonly reason?: string;
  readonly traceId?: string;
}
export type ToCreateRoomInviteGroupStateRequestInput =
  RoomGroupStateRequestInput<CreateStateGroupInviteBody>;
export type ToRemoveRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<RemoveStateGroupMemberBody>;
export type ToBanRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<BanStateGroupMemberBody>;
export type ToUnbanRoomMemberGroupStateRequestInput =
  RoomGroupStateRequestInput<UnbanStateGroupMemberBody>;
export type ToSetRoomMemberRoleGroupStateRequestInput =
  RoomGroupStateRequestInput<SetStateGroupMemberRoleBody>;
export type ToTransferRoomOwnershipGroupStateRequestInput =
  RoomGroupStateRequestInput<TransferStateGroupOwnershipBody>;

export interface ToConnectRoomPresenceGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly principalId: string;
  readonly generationId: string;
}

export interface ToDisconnectRoomPresenceGroupStateRequestInput extends RoomGroupStateMutationActorInput {
  readonly principalId: string;
  readonly generationId: string;
}

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
): CreateStateGroupBody {
  const { room } = input;
  return {
    groupId: input.groupId,
    slug: toRoomGroupStateSlug(room.displayName),
    displayName: room.displayName,
    kind: 'room',
    ...(room.description === undefined ? {} : { description: room.description }),
    joinMode: room.joinMode ?? 'invite-only',
    ...(room.maxMembers === undefined ? {} : { maxMembers: room.maxMembers }),
    ...(room.maxSessionsPerMember === undefined
      ? {}
      : { maxSessionsPerMember: room.maxSessionsPerMember }),
    createdByPrincipalId: input.actorPrincipalId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    metadata: room.metadata ?? {},
    ...(room.expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs: room.expiresAtEpochMs }),
    ...(room.purgeAfterEpochMs === undefined ? {} : { purgeAfterEpochMs: room.purgeAfterEpochMs }),
  };
}

export function toUpdateGroupStateRequest(
  input: ToUpdateGroupStateRequestInput,
): UpdateStateGroupBody {
  return {
    ...toRoomUpdateFields(input.request),
    ...toActorRequest(input),
  };
}

export function toJoinGroupStateRequest(input: ToJoinGroupStateRequestInput): JoinStateGroupBody {
  return {
    ...(input.room.inviteToken === undefined ? {} : { inviteToken: input.room.inviteToken }),
    ...(input.room.joinCode === undefined ? {} : { joinCode: input.room.joinCode }),
    ...toActorRequest(input),
  };
}

export function toRoomLifecycleGroupStateRequest(
  input: ToRoomLifecycleGroupStateRequestInput,
): UpdateStateGroupBody {
  return {
    ...toRoomUpdateFields(input.request),
    status: input.status,
    ...toActorRequest(input),
  };
}

export function toRoomMetadataGroupStateRequest(
  input: ToRoomMetadataGroupStateRequestInput,
): UpdateStateGroupBody {
  return {
    metadata: { ...input.currentMetadata, ...input.patch },
    ...toActorRequest(input),
  };
}

export function toCreateRoomInviteGroupStateRequest(
  input: ToCreateRoomInviteGroupStateRequestInput,
): CreateStateGroupInviteBody {
  return {
    ...(input.request.invitationExpiresAtEpochMs === undefined
      ? {}
      : { invitationExpiresAtEpochMs: input.request.invitationExpiresAtEpochMs }),
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toAcceptRoomInviteGroupStateRequest(
  input: RoomGroupStateMutationActorInput,
): AcceptStateGroupInviteBody {
  return toActorRequest(input);
}

export function toRemoveRoomMemberGroupStateRequest(
  input: ToRemoveRoomMemberGroupStateRequestInput,
): RemoveStateGroupMemberBody {
  return {
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toBanRoomMemberGroupStateRequest(
  input: ToBanRoomMemberGroupStateRequestInput,
): BanStateGroupMemberBody {
  return {
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toUnbanRoomMemberGroupStateRequest(
  input: ToUnbanRoomMemberGroupStateRequestInput,
): UnbanStateGroupMemberBody {
  return {
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toSetRoomMemberRoleGroupStateRequest(
  input: ToSetRoomMemberRoleGroupStateRequestInput,
): SetStateGroupMemberRoleBody {
  return {
    role: input.request.role,
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toTransferRoomOwnershipGroupStateRequest(
  input: ToTransferRoomOwnershipGroupStateRequestInput,
): TransferStateGroupOwnershipBody {
  return {
    newOwnerPrincipalId: input.request.newOwnerPrincipalId,
    ...toMutationAuditFields(input.request),
    ...toActorRequest(input),
  };
}

export function toConnectRoomPresenceGroupStateRequest(
  input: ToConnectRoomPresenceGroupStateRequestInput,
): ConnectStateGroupPresenceSessionBody {
  return {
    principalId: input.principalId,
    generationId: input.generationId,
    ...toActorRequest(input),
  };
}

export function toDisconnectRoomPresenceGroupStateRequest(
  input: ToDisconnectRoomPresenceGroupStateRequestInput,
): DisconnectStateGroupPresenceSessionBody {
  return {
    generationId: input.generationId,
    principalId: input.principalId,
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    reason: 'left-group',
  };
}

export function toLeaveRoomMemberGroupStateRequest(
  input: RoomGroupStateMutationActorInput,
): UpsertStateGroupMemberBody {
  return {
    status: 'left',
    actorPrincipalId: input.actorPrincipalId,
    actorSessionId: input.actorSessionId,
    reason: 'left-group',
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
}: RoomGroupStateMutationActorInput): RoomGroupStateMutationActorInput {
  return {
    actorPrincipalId,
    actorSessionId,
  };
}

function toRoomUpdateFields(request: UpdateStateGroupBody): UpdateStateGroupBody {
  return {
    ...(request.slug === undefined ? {} : { slug: request.slug }),
    ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(request.kind === undefined ? {} : { kind: request.kind }),
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.joinMode === undefined ? {} : { joinMode: request.joinMode }),
    ...(request.maxMembers === undefined ? {} : { maxMembers: request.maxMembers }),
    ...(request.maxSessionsPerMember === undefined
      ? {}
      : { maxSessionsPerMember: request.maxSessionsPerMember }),
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
    ...(request.expiresAtEpochMs === undefined
      ? {}
      : { expiresAtEpochMs: request.expiresAtEpochMs }),
    ...(request.emptySinceEpochMs === undefined
      ? {}
      : { emptySinceEpochMs: request.emptySinceEpochMs }),
    ...(request.purgeAfterEpochMs === undefined
      ? {}
      : { purgeAfterEpochMs: request.purgeAfterEpochMs }),
    ...toMutationAuditFields(request),
  };
}

function toMutationAuditFields(
  request: RoomGroupStateMutationAuditFields,
): RoomGroupStateMutationAuditFields {
  return {
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
  };
}

function toRoomGroupStateSlug(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
