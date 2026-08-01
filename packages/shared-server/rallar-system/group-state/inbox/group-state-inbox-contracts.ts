import type {
  AcceptGroupInviteRequest,
  AppointGroupDirectorRequest,
  BanGroupMemberRequest,
  ConnectGroupPresenceSessionRequest,
  CreateGroupInviteRequest,
  CreateGroupRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
  JoinGroupRequest,
  RemoveGroupMemberRequest,
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
  SetGroupMemberRoleRequest,
  StateScope,
  TransferGroupOwnershipRequest,
  UnbanGroupMemberRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';

import { AppInboxType } from '../../services/AppInboxService.ts';

export type GroupCreateAppInboxPayload = Readonly<{
  scope: StateScope;
  request: CreateGroupRequest;
}>;

export type GroupUpdateAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: UpdateGroupRequest;
}>;

export type GroupDirectorAppointAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: AppointGroupDirectorRequest;
}>;

export type GroupJoinAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: JoinGroupRequest;
}>;

export type GroupInviteCreateAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: CreateGroupInviteRequest;
}>;

export type GroupInviteRevokeAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: RevokeGroupInviteRequest;
}>;

export type GroupInviteAcceptAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: AcceptGroupInviteRequest;
}>;

export type GroupJoinCodeRotateAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: RotateGroupJoinCodeRequest;
}>;

export type GroupMemberRemoveAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: RemoveGroupMemberRequest;
}>;

export type GroupMemberBanAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: BanGroupMemberRequest;
}>;

export type GroupMemberUnbanAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: UnbanGroupMemberRequest;
}>;

export type GroupMemberRoleSetAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: SetGroupMemberRoleRequest;
}>;

export type GroupOwnershipTransferAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  request: TransferGroupOwnershipRequest;
}>;

export type GroupMemberUpsertAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  principalId: string;
  request: UpsertGroupMemberRequest;
}>;

export type GroupPresenceConnectAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  sessionId: string;
  request: ConnectGroupPresenceSessionRequest;
}>;

export type GroupPresenceHeartbeatAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  sessionId: string;
  request: HeartbeatGroupPresenceSessionRequest;
}>;

export type GroupPresenceDisconnectAppInboxPayload = Readonly<{
  scope: StateScope;
  groupId: string;
  sessionId: string;
  request: DisconnectGroupPresenceSessionRequest;
}>;

export const AUTHENTICATED_GROUP_INBOX_TYPES = [
  AppInboxType.GROUP_CREATE,
  AppInboxType.GROUP_UPDATE,
  AppInboxType.GROUP_DIRECTOR_APPOINT,
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
] as const;

export const GROUP_MUTATION_INBOX_TYPES = [
  ...AUTHENTICATED_GROUP_INBOX_TYPES,
  AppInboxType.GROUP_PRESENCE_EXPIRE,
  AppInboxType.GROUP_PRESENCE_SESSION_CLEANUP,
] as const;

export function isAuthenticatedGroupMutationInboxType(type: AppInboxType): boolean {
  return (AUTHENTICATED_GROUP_INBOX_TYPES as readonly AppInboxType[]).includes(type);
}
