import type {
  ConnectGroupPresenceSessionRequest,
  DisconnectGroupPresenceSessionRequest,
  HeartbeatGroupPresenceSessionRequest,
} from '@shared/api/state-types.ts';

import {
  GroupMutationRejectedError,
  type GroupMutationCommand,
} from './group-mutation-contracts.ts';
import {
  assertExactKeys,
  requireJsonSafe,
  requireNonEmptyString,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
} from '../group-state-validation-primitives.ts';

export function validateGroupMutationRequest(
  operation: GroupMutationCommand['operation'],
  request: unknown,
): void {
  requireJsonSafe(request, `Group ${operation} request`);
  const input = requireRecord(request, `Group ${operation} request`);
  assertExactKeys(input, GROUP_MUTATION_REQUEST_KEYS[operation], `Group ${operation} request`);
  requireNonEmptyString(input.requestId, `Group ${operation} requestId`);
  requireNonEmptyString(input.actorPrincipalId, `Group ${operation} actorPrincipalId`);
  requireNonEmptyString(input.actorSessionId, `Group ${operation} actorSessionId`);
  for (const key of ['reason', 'traceId']) {
    if (input[key] !== undefined) {
      requireNonEmptyString(input[key], `Group ${operation} ${key}`);
    }
  }
  const optionalString = (key: string) => {
    if (input[key] !== undefined) {
      requireNonEmptyString(input[key], `Group ${operation} ${key}`);
    }
  };
  const optionalPositiveInteger = (key: string) => {
    if (input[key] !== undefined) {
      requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
    }
  };
  switch (operation) {
    case 'createGroup':
      requireNonEmptyString(input.groupId, 'Group createGroup groupId');
      optionalString('slug');
      requireNonEmptyString(input.displayName, 'Group createGroup displayName');
      optionalString('description');
      requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      if (input.joinMode !== undefined) {
        requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      }
      optionalPositiveInteger('maxMembers');
      optionalPositiveInteger('maxSessionsPerMember');
      if (input.metadata !== undefined) requireRecord(input.metadata, 'Group metadata');
      requireNonEmptyString(input.createdByPrincipalId, 'Group createGroup createdByPrincipalId');
      optionalPositiveInteger('expiresAtEpochMs');
      optionalPositiveInteger('purgeAfterEpochMs');
      return;
    case 'updateGroup':
      optionalString('slug');
      optionalString('displayName');
      optionalString('description');
      if (input.kind !== undefined)
        requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      if (input.status !== undefined)
        requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
      if (input.joinMode !== undefined)
        requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      optionalPositiveInteger('maxMembers');
      optionalPositiveInteger('maxSessionsPerMember');
      if (input.metadata !== undefined) requireRecord(input.metadata, 'Group metadata');
      optionalPositiveInteger('expiresAtEpochMs');
      optionalPositiveInteger('emptySinceEpochMs');
      optionalPositiveInteger('purgeAfterEpochMs');
      return;
    case 'appointDirector':
      optionalPositiveInteger('heartbeatTtlMs');
      return;
    case 'joinGroup':
    case 'acceptGroupInvite':
      optionalString('inviteToken');
      optionalString('joinCode');
      return;
    case 'createGroupInvite':
      optionalPositiveInteger('invitationExpiresAtEpochMs');
      return;
    case 'setGroupMemberRole':
      requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      return;
    case 'transferGroupOwnership':
      requireNonEmptyString(
        input.newOwnerPrincipalId,
        'Group transferGroupOwnership newOwnerPrincipalId',
      );
      return;
    case 'upsertMember':
      if (input.role !== undefined) {
        requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      }
      requireOneOf(
        input.status,
        ['invited', 'active', 'left', 'removed', 'banned'],
        'Group member status',
      );
      optionalString('invitedByPrincipalId');
      optionalPositiveInteger('invitationExpiresAtEpochMs');
      return;
    case 'rotateGroupJoinCode':
      optionalString('joinCode');
      optionalPositiveInteger('expiresAtEpochMs');
      return;
    case 'connectPresence':
      validateGroupPresenceMutationRequest('connectPresence', request);
      return;
    case 'heartbeatPresence':
      validateGroupPresenceMutationRequest('heartbeatPresence', request);
      return;
    case 'disconnectPresence':
      validateGroupPresenceMutationRequest('disconnectPresence', request);
      return;
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
      return;
  }
}

export function validateGroupPresenceMutationRequest(
  operation: 'connectPresence',
  request: unknown,
): asserts request is ConnectGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
  operation: 'heartbeatPresence',
  request: unknown,
): asserts request is HeartbeatGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
  operation: 'disconnectPresence',
  request: unknown,
): asserts request is DisconnectGroupPresenceSessionRequest;
export function validateGroupPresenceMutationRequest(
  operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence',
  request: unknown,
): void {
  requireJsonSafe(request, `Group ${operation} request`);
  const value = requireRecord(request, `Group ${operation} request`);
  assertExactKeys(
    value,
    [
      'requestId',
      'actorPrincipalId',
      'actorSessionId',
      'reason',
      'traceId',
      'generationId',
      'principalId',
      ...(operation === 'connectPresence' ? ['connectedAtEpochMs'] : []),
      ...(operation === 'disconnectPresence' ? ['disconnectedAtEpochMs'] : []),
      'lastHeartbeatAtEpochMs',
      'expiresAtEpochMs',
    ],
    `Group ${operation} request`,
  );
  requireNonEmptyString(value.generationId, `Group ${operation} generationId`);
  for (const field of [
    'requestId',
    'actorPrincipalId',
    'actorSessionId',
    'reason',
    'traceId',
    'principalId',
  ]) {
    if (value[field] !== undefined) {
      requireNonEmptyString(value[field], `Group ${operation} ${field}`);
    }
  }
  const timestampFields =
    operation === 'connectPresence'
      ? ['connectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs']
      : operation === 'heartbeatPresence'
        ? ['lastHeartbeatAtEpochMs', 'expiresAtEpochMs']
        : ['disconnectedAtEpochMs', 'lastHeartbeatAtEpochMs', 'expiresAtEpochMs'];
  for (const field of timestampFields) {
    const timestamp = value[field];
    if (
      timestamp !== undefined &&
      (!Number.isSafeInteger(timestamp) || (timestamp as number) <= 0)
    ) {
      throw new GroupMutationRejectedError(
        `Group ${operation} ${field} must be a positive safe integer`,
      );
    }
  }
  const heartbeatAt = value.lastHeartbeatAtEpochMs as number | undefined;
  const expiresAt = value.expiresAtEpochMs as number | undefined;
  if (heartbeatAt !== undefined && expiresAt !== undefined && expiresAt < heartbeatAt) {
    throw new GroupMutationRejectedError(
      `Group ${operation} expiresAtEpochMs must not predate lastHeartbeatAtEpochMs`,
    );
  }
  if (operation === 'connectPresence') {
    const connectedAt = value.connectedAtEpochMs as number | undefined;
    if (connectedAt !== undefined && heartbeatAt !== undefined && heartbeatAt < connectedAt) {
      throw new GroupMutationRejectedError(
        'Group connectPresence lastHeartbeatAtEpochMs must not predate connectedAtEpochMs',
      );
    }
  }
  if (operation === 'disconnectPresence') {
    const disconnectedAt = value.disconnectedAtEpochMs as number | undefined;
    if (disconnectedAt !== undefined && heartbeatAt !== undefined && disconnectedAt < heartbeatAt) {
      throw new GroupMutationRejectedError(
        'Group disconnectPresence disconnectedAtEpochMs must not predate lastHeartbeatAtEpochMs',
      );
    }
  }
}

export const ACTOR_INPUT_KEYS = [
  'actorPrincipalId',
  'actorSessionId',
  'reason',
  'traceId',
] as const;

const MUTATION_REQUEST_KEYS = [...ACTOR_INPUT_KEYS, 'requestId'] as const;

const GROUP_MUTATION_REQUEST_KEYS: Readonly<
  Record<GroupMutationCommand['operation'], readonly string[]>
> = {
  createGroup: [
    ...MUTATION_REQUEST_KEYS,
    'groupId',
    'slug',
    'displayName',
    'description',
    'kind',
    'joinMode',
    'maxMembers',
    'maxSessionsPerMember',
    'metadata',
    'createdByPrincipalId',
    'expiresAtEpochMs',
    'purgeAfterEpochMs',
  ],
  updateGroup: [
    ...MUTATION_REQUEST_KEYS,
    'slug',
    'displayName',
    'description',
    'kind',
    'status',
    'joinMode',
    'maxMembers',
    'maxSessionsPerMember',
    'metadata',
    'expiresAtEpochMs',
    'emptySinceEpochMs',
    'purgeAfterEpochMs',
  ],
  appointDirector: [...MUTATION_REQUEST_KEYS, 'heartbeatTtlMs'],
  joinGroup: [...MUTATION_REQUEST_KEYS, 'inviteToken', 'joinCode'],
  acceptGroupInvite: MUTATION_REQUEST_KEYS,
  createGroupInvite: [...MUTATION_REQUEST_KEYS, 'invitationExpiresAtEpochMs'],
  revokeGroupInvite: MUTATION_REQUEST_KEYS,
  removeGroupMember: MUTATION_REQUEST_KEYS,
  banGroupMember: MUTATION_REQUEST_KEYS,
  unbanGroupMember: MUTATION_REQUEST_KEYS,
  setGroupMemberRole: [...MUTATION_REQUEST_KEYS, 'role'],
  transferGroupOwnership: [...MUTATION_REQUEST_KEYS, 'newOwnerPrincipalId'],
  upsertMember: [
    ...MUTATION_REQUEST_KEYS,
    'role',
    'status',
    'invitedByPrincipalId',
    'invitationExpiresAtEpochMs',
  ],
  rotateGroupJoinCode: [...MUTATION_REQUEST_KEYS, 'joinCode', 'expiresAtEpochMs'],
  connectPresence: [
    ...MUTATION_REQUEST_KEYS,
    'principalId',
    'generationId',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
  heartbeatPresence: [
    ...MUTATION_REQUEST_KEYS,
    'principalId',
    'generationId',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
  disconnectPresence: [
    ...MUTATION_REQUEST_KEYS,
    'principalId',
    'generationId',
    'generationVersion',
    'observedExpiresAtEpochMs',
    'disconnectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
};
