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

import type { GroupMutationCommand } from '../services/group-state-mutations.ts';
import type { GroupMutationDescriptor } from './group-state-service-contracts.ts';

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
      return toUpdateCommand(
        descriptor.scope,
        descriptor.groupId,
        descriptor.request as UpdateGroupRequest,
        randomId,
      );
    case 'appointDirector':
      return toDirectorCommand(
        descriptor.scope,
        descriptor.groupId,
        descriptor.request as AppointGroupDirectorRequest,
        randomId,
      );
    case 'rotateGroupJoinCode':
      return toRotateCommand(
        descriptor.scope,
        descriptor.groupId,
        descriptor.request as RotateGroupJoinCodeRequest,
        randomId,
      );
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
      return toJoinCommand(
        descriptor.operation,
        descriptor.scope,
        descriptor.groupId,
        descriptor.request as JoinGroupRequest | AcceptGroupInviteRequest,
        randomId,
      );
    case 'createGroupInvite':
      return toInviteCommand(
        descriptor.scope,
        descriptor.groupId,
        requireTargetPrincipalId(descriptor),
        descriptor.request as CreateGroupInviteRequest,
        randomId,
      );
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
      return toTargetCommand(
        descriptor.operation,
        descriptor.scope,
        descriptor.groupId,
        requireTargetPrincipalId(descriptor),
        descriptor.request as RevokeGroupInviteRequest,
        randomId,
      );
    case 'setGroupMemberRole':
      return toRoleCommand(
        descriptor.scope,
        descriptor.groupId,
        requireTargetPrincipalId(descriptor),
        descriptor.request as SetGroupMemberRoleRequest,
        randomId,
      );
    case 'transferGroupOwnership':
      return toTransferCommand(descriptor, randomId);
    case 'upsertMember':
      return toUpsertMemberCommand(
        descriptor.scope,
        descriptor.groupId,
        requireTargetPrincipalId(descriptor),
        descriptor.request as UpsertGroupMemberRequest,
        randomId,
      );
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
      ...toActorInput(request),
      actorPrincipalId: request.actorPrincipalId ?? request.createdByPrincipalId,
    },
  };
}

function toUpdateCommand(
  scope: StateScope,
  groupId: string,
  request: UpdateGroupRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'updateGroup',
    aggregateRef: { ...scope, groupId },
    ...toIdentity(request.requestId, randomId),
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
      ...toActorInput(request),
    },
  };
}

function toDirectorCommand(
  scope: StateScope,
  groupId: string,
  request: AppointGroupDirectorRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'appointDirector',
    aggregateRef: { ...scope, groupId },
    ...toIdentity(request.requestId, randomId),
    input: {
      heartbeatTtlMs: normalizeRallarGroupDirectorHeartbeatTtlMs(
        request.heartbeatTtlMs ?? DEFAULT_RALLAR_GROUP_DIRECTOR_HEARTBEAT_TTL_MS,
      ),
      ...toActorInput(request),
    },
  };
}

function toJoinCommand(
  operation: 'joinGroup' | 'acceptGroupInvite',
  scope: StateScope,
  groupId: string,
  request: JoinGroupRequest | AcceptGroupInviteRequest,
  randomId: () => string,
): GroupMutationCommand {
  if (!request.actorPrincipalId) {
    throw new NonRetryableException('Forbidden: Cannot join a group without a principal.');
  }
  return {
    operation,
    aggregateRef: { ...scope, groupId },
    targetPrincipalId: request.actorPrincipalId,
    ...toIdentity(request.requestId, randomId),
    input: {
      inviteToken: 'inviteToken' in request ? (request.inviteToken ?? null) : null,
      joinCode:
        'joinCode' in request && request.joinCode ? normalizeJoinCode(request.joinCode) : null,
      ...toActorInput(request),
    },
  };
}

function toInviteCommand(
  scope: StateScope,
  groupId: string,
  principalId: string,
  request: CreateGroupInviteRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'createGroupInvite',
    aggregateRef: { ...scope, groupId },
    targetPrincipalId: principalId,
    ...toIdentity(request.requestId, randomId),
    input: {
      invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
      ...toActorInput(request),
    },
  };
}

function toTargetCommand(
  operation: 'revokeGroupInvite' | 'removeGroupMember' | 'banGroupMember' | 'unbanGroupMember',
  scope: StateScope,
  groupId: string,
  principalId: string,
  request: RevokeGroupInviteRequest | RemoveGroupMemberRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation,
    aggregateRef: { ...scope, groupId },
    targetPrincipalId: principalId,
    ...toIdentity(request.requestId, randomId),
    input: toActorInput(request),
  };
}

function toRoleCommand(
  scope: StateScope,
  groupId: string,
  principalId: string,
  request: SetGroupMemberRoleRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'setGroupMemberRole',
    aggregateRef: { ...scope, groupId },
    targetPrincipalId: principalId,
    ...toIdentity(request.requestId, randomId),
    input: { role: request.role, ...toActorInput(request) },
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
    ...toIdentity(request.requestId, randomId),
    input: toActorInput(request),
  };
}

function toUpsertMemberCommand(
  scope: StateScope,
  groupId: string,
  principalId: string,
  request: UpsertGroupMemberRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'upsertMember',
    aggregateRef: { ...scope, groupId },
    targetPrincipalId: principalId,
    ...toIdentity(request.requestId, randomId),
    input: {
      role: request.role ?? null,
      status: request.status,
      invitedByPrincipalId: request.invitedByPrincipalId ?? null,
      invitationExpiresAtEpochMs: request.invitationExpiresAtEpochMs ?? null,
      ...toActorInput(request),
    },
  };
}

function toRotateCommand(
  scope: StateScope,
  groupId: string,
  request: RotateGroupJoinCodeRequest,
  randomId: () => string,
): GroupMutationCommand {
  return {
    operation: 'rotateGroupJoinCode',
    aggregateRef: { ...scope, groupId },
    ...toIdentity(request.requestId, randomId),
    input: {
      joinCode: request.joinCode === undefined ? null : normalizeJoinCode(request.joinCode),
      expiresAtEpochMs: request.expiresAtEpochMs ?? null,
      ...toActorInput(request),
    },
  };
}

function toIdentity(requestId: string | undefined, randomId: () => string) {
  const commandId = requestId ?? randomId();
  return { commandId, requestId: requestId ?? null };
}

function toActorInput(
  request: Readonly<{
    actorPrincipalId?: string;
    actorSessionId?: string;
    reason?: string;
    traceId?: string;
  }>,
) {
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
