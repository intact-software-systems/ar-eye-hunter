import {
  DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
  normalizeRallarGroupDirectorHeartbeatTtlMs,
} from '@shared/api/group-director.ts';
import type {
  AcceptGroupInviteRequest,
  AppointGroupDirectorRequest,
  CreateGroupInviteRequest,
  CreateGroupRequest,
  JoinGroupRequest,
  RemoveGroupMemberRequest,
  RevokeGroupInviteRequest,
  RotateGroupJoinCodeRequest,
  SetGroupMemberRoleRequest,
  StateScope,
  TransferGroupOwnershipRequest,
  UpdateGroupRequest,
  UpsertGroupMemberRequest,
} from '@shared/api/state-types.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';

import type { GroupMutationCommand } from './mutation/group-mutation-contracts.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';

export interface GroupMutationIdentity {
  readonly commandId: string;
  readonly requestId: string | null;
}

export interface GroupMutationActorInput {
  readonly actorPrincipalId: string | null;
  readonly actorSessionId: string | null;
  readonly reason: string | null;
  readonly traceId: string | null;
}

export function toAggregateMutationCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  switch (descriptor.operation) {
    case 'createGroup': {
      const request = descriptor.request as CreateGroupRequest;
      if (request.groupId !== descriptor.groupId) {
        throw new NonRetryableException('Group create identity is inconsistent');
      }
      return toCreateCommand(descriptor.scope, request, randomId);
    }
    case 'updateGroup':
      return toUpdateCommand(descriptor, randomId);
    case 'appointDirector':
      return toDirectorCommand(descriptor, randomId);
    case 'rotateGroupJoinCode':
      return toRotateCommand(descriptor, randomId);
    default:
      throw new TypeError(`Unsupported aggregate group mutation: ${descriptor.operation}`);
  }
}

export function toMembershipMutationCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  switch (descriptor.operation) {
    case 'joinGroup':
    case 'acceptGroupInvite':
      return toJoinCommand(descriptor, randomId);
    case 'createGroupInvite':
      return toInviteCommand(descriptor, randomId);
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
      return toTargetCommand(descriptor, randomId);
    case 'setGroupMemberRole':
      return toRoleCommand(descriptor, randomId);
    case 'transferGroupOwnership':
      return toTransferCommand(descriptor, randomId);
    case 'upsertMember':
      return toUpsertMemberCommand(descriptor, randomId);
    default:
      throw new TypeError(`Unsupported membership group mutation: ${descriptor.operation}`);
  }
}

function requireTargetPrincipalId(descriptor: GroupMutationDescriptor): string {
  if (!descriptor.targetPrincipalId) {
    throw new NonRetryableException('Group mutation target principal is required');
  }
  return descriptor.targetPrincipalId;
}

function toCreateCommand(
  scope: StateScope,
  request: CreateGroupRequest,
  randomId: () => string,
): GroupMutationCommand {
  const commandId = request.requestId ?? randomId();
  return {
    operation: 'createGroup',
    aggregateRef: { ...scope, groupId: request.groupId },
    commandId,
    requestId: request.requestId ?? commandId,
    input: {
      slug: request.slug ?? null,
      displayName: request.displayName,
      description: request.description ?? null,
      kind: request.kind,
      joinMode: request.joinMode ?? 'invite-only',
      maxMembers: request.maxMembers ?? null,
      maxSessionsPerMember: request.maxSessionsPerMember ?? null,
      metadata: structuredClone(request.metadata ?? {}),
      createdByPrincipalId: request.createdByPrincipalId,
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
      ...toGroupMutationActorInput(request),
      actorPrincipalId: request.actorPrincipalId ?? request.createdByPrincipalId,
    },
  };
}

function toUpdateCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as UpdateGroupRequest;
  return {
    operation: 'updateGroup',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      slug: request.slug ?? null,
      displayName: request.displayName ?? null,
      description: request.description ?? null,
      kind: request.kind ?? null,
      status: request.status ?? null,
      joinMode: request.joinMode ?? null,
      maxMembers: request.maxMembers ?? null,
      maxSessionsPerMember: request.maxSessionsPerMember ?? null,
      metadata: request.metadata ? structuredClone(request.metadata) : null,
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      emptySinceEpochMs: request.emptySinceEpochMs ?? null,
      purgeAfterEpochMs: request.purgeAfterEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

function toDirectorCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as AppointGroupDirectorRequest;
  return {
    operation: 'appointDirector',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      heartbeatTtlMs: normalizeRallarGroupDirectorHeartbeatTtlMs(
        request.heartbeatTtlMs ?? DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
      ),
      ...toGroupMutationActorInput(request),
    },
  };
}

function toJoinCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as JoinGroupRequest | AcceptGroupInviteRequest;
  if (!request.actorPrincipalId) {
    throw new NonRetryableException('Forbidden: Cannot join a group without a principal.');
  }
  return {
    operation: descriptor.operation as 'joinGroup' | 'acceptGroupInvite',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: request.actorPrincipalId,
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      inviteToken: 'inviteToken' in request ? (request.inviteToken ?? null) : null,
      joinCode:
        'joinCode' in request && request.joinCode ? normalizeJoinCode(request.joinCode) : null,
      ...toGroupMutationActorInput(request),
    },
  };
}

function toInviteCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as CreateGroupInviteRequest;
  return {
    operation: 'createGroupInvite',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: requireTargetPrincipalId(descriptor),
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

function toTargetCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as RevokeGroupInviteRequest | RemoveGroupMemberRequest;
  return {
    operation: descriptor.operation as
      'revokeGroupInvite' | 'removeGroupMember' | 'banGroupMember' | 'unbanGroupMember',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: requireTargetPrincipalId(descriptor),
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: toGroupMutationActorInput(request),
  };
}

function toRoleCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as SetGroupMemberRoleRequest;
  return {
    operation: 'setGroupMemberRole',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: requireTargetPrincipalId(descriptor),
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: { role: request.role, ...toGroupMutationActorInput(request) },
  };
}

function toTransferCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as TransferGroupOwnershipRequest;
  if (descriptor.targetPrincipalId !== request.newOwnerPrincipalId) {
    throw new NonRetryableException('Ownership target identity is inconsistent');
  }
  return {
    operation: 'transferGroupOwnership',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: request.newOwnerPrincipalId,
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: toGroupMutationActorInput(request),
  };
}

function toUpsertMemberCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as UpsertGroupMemberRequest;
  return {
    operation: 'upsertMember',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    targetPrincipalId: requireTargetPrincipalId(descriptor),
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      role: request.role ?? null,
      status: request.status,
      invitedByPrincipalId: request.invitedByPrincipalId ?? null,
      invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

function toRotateCommand(
  descriptor: GroupMutationDescriptor,
  randomId: () => string,
): GroupMutationCommand {
  const request = descriptor.request as RotateGroupJoinCodeRequest;
  return {
    operation: 'rotateGroupJoinCode',
    aggregateRef: { ...descriptor.scope, groupId: descriptor.groupId },
    ...toGroupMutationIdentity(request.requestId, randomId),
    input: {
      joinCode: request.joinCode === undefined ? null : normalizeJoinCode(request.joinCode),
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      ...toGroupMutationActorInput(request),
    },
  };
}

export function toGroupMutationIdentity(
  requestId: string | undefined,
  randomId: () => string,
): GroupMutationIdentity {
  const commandId = requestId ?? randomId();
  return { commandId, requestId: requestId ?? null };
}

export function toGroupMutationActorInput(
  request: Readonly<{
    actorPrincipalId?: string;
    actorSessionId?: string;
    reason?: string;
    traceId?: string;
  }>,
): GroupMutationActorInput {
  return {
    actorPrincipalId: request.actorPrincipalId ?? null,
    actorSessionId: request.actorSessionId ?? null,
    reason: request.reason ?? null,
    traceId: request.traceId ?? null,
  };
}

function normalizeJoinCode(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/gu, '')
    .slice(0, 12);
  if (normalized.length < 4) {
    throw new NonRetryableException('Group join code must contain at least four characters');
  }
  return normalized;
}
