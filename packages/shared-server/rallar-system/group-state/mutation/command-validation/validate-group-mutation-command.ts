import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import { ACTOR_INPUT_KEYS } from './group-mutation-request-validation.ts';
import {
  assertExactKeys,
  requireJsonSafe,
  requireNonEmptyString,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
  validateGroupRef,
} from '../../group-state-validation-primitives.ts';

export function validateGroupMutationCommand(
  command: unknown,
): asserts command is GroupMutationCommand {
  requireJsonSafe(command, 'Group mutation command');
  const value = requireRecord(command, 'Group mutation command');
  if ('commandHash' in value) {
    throw new TypeError('Group mutation command must not contain commandHash');
  }
  requireNonEmptyString(value.operation, 'Group mutation operation');
  if (!GROUP_MUTATION_OPERATIONS.has(value.operation)) {
    throw new TypeError('Group mutation operation is invalid');
  }
  const operation = value.operation as GroupMutationCommand['operation'];
  const hasTarget = TARGET_GROUP_MUTATION_OPERATIONS.has(operation);
  const hasSession = PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation);
  assertExactKeys(
    value,
    [
      'operation',
      'aggregateRef',
      'commandId',
      'requestId',
      'input',
      ...(hasTarget ? ['targetPrincipalId'] : []),
      ...(hasSession ? ['sessionId'] : []),
    ],
    'Group mutation command',
  );
  requireNonEmptyString(value.commandId, 'Group mutation commandId');
  if (value.requestId !== null) {
    requireNonEmptyString(value.requestId, 'Group mutation requestId');
  }
  validateGroupRef(value.aggregateRef);
  const input = requireRecord(value.input, 'Group mutation input');
  assertExactKeys(input, GROUP_MUTATION_INPUT_KEYS[operation], `Group ${operation} input`);
  for (const key of ['actorPrincipalId', 'actorSessionId', 'reason', 'traceId']) {
    if (input[key] !== null) requireNonEmptyString(input[key], `Group mutation ${key}`);
  }
  if ('sessionId' in value) requireNonEmptyString(value.sessionId, 'Group session id');
  if ('targetPrincipalId' in value) {
    requireNonEmptyString(value.targetPrincipalId, 'Group target principal id');
  }
  if (hasSession) {
    requireNonEmptyString(input.generationId, 'Group presence generationId');
  }
  validateOperationInput(operation, input);
}

function validateOperationInput(
  operation: GroupMutationCommand['operation'],
  input: Readonly<Record<string, unknown>>,
): void {
  if (AGGREGATE_GROUP_MUTATION_OPERATIONS.has(operation)) {
    validateAggregateOperationInput(operation, input);
    return;
  }
  if (PRESENCE_GROUP_MUTATION_OPERATIONS.has(operation)) {
    validatePresenceOperationInput(operation, input);
    return;
  }
  validateMembershipOperationInput(operation, input);
}

function validateAggregateOperationInput(
  operation: GroupMutationCommand['operation'],
  input: Readonly<Record<string, unknown>>,
): void {
  switch (operation) {
    case 'createGroup':
      validateNullableString(input, 'slug');
      requireNonEmptyString(input.displayName, 'Group displayName');
      validateNullableString(input, 'description');
      requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      validateNullableInteger(input, 'maxMembers', true);
      validateNullableInteger(input, 'maxSessionsPerMember', true);
      requireRecord(input.metadata, 'Group metadata');
      requireNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId');
      validateNullableInteger(input, 'expiresAtEpochMs', true);
      validateNullableInteger(input, 'purgeAfterEpochMs', true);
      if (input.lifecyclePolicy !== undefined) {
        requireRecord(input.lifecyclePolicy, 'Group lifecyclePolicy');
      }
      return;
    case 'updateGroup':
      validateNullableString(input, 'slug');
      validateNullableString(input, 'displayName');
      validateNullableString(input, 'description');
      if (input.kind !== null)
        requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      if (input.status !== null)
        requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
      if (input.joinMode !== null)
        requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      validateNullableInteger(input, 'maxMembers', true);
      validateNullableInteger(input, 'maxSessionsPerMember', true);
      if (input.metadata !== null) requireRecord(input.metadata, 'Group metadata');
      validateNullableInteger(input, 'expiresAtEpochMs', true);
      validateNullableInteger(input, 'emptySinceEpochMs', true);
      validateNullableInteger(input, 'purgeAfterEpochMs', true);
      return;
    case 'appointDirector':
      requirePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
      return;
    case 'rotateGroupJoinCode':
      validateNullableString(input, 'joinCode');
      validateNullableInteger(input, 'expiresAtEpochMs', true);
      return;
    default:
      return;
  }
}

function validateMembershipOperationInput(
  operation: GroupMutationCommand['operation'],
  input: Readonly<Record<string, unknown>>,
): void {
  switch (operation) {
    case 'joinGroup':
    case 'acceptGroupInvite':
      validateNullableString(input, 'inviteToken');
      validateNullableString(input, 'joinCode');
      return;
    case 'createGroupInvite':
      validateNullableInteger(input, 'invitationExpiresAtEpochMs', true);
      return;
    case 'setGroupMemberRole':
      requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      return;
    case 'upsertMember':
      if (input.role !== null) requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      // 'pending' is deliberately absent: only the admission decision may
      // compute it, never client input (plan decision 5.1).
      requireOneOf(
        input.status,
        ['invited', 'active', 'left', 'removed', 'banned'],
        'Group member status',
      );
      validateNullableString(input, 'invitedByPrincipalId');
      validateNullableInteger(input, 'invitationExpiresAtEpochMs', true);
      return;
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
    case 'transferGroupOwnership':
      return;
  }
}

function validatePresenceOperationInput(
  operation: GroupMutationCommand['operation'],
  input: Readonly<Record<string, unknown>>,
): void {
  if (operation === 'connectPresence') {
    requireNonEmptyString(input.principalId, 'Group presence principalId');
    validateNullableInteger(input, 'connectedAtEpochMs', true);
  } else {
    validateNullableString(input, 'principalId');
  }
  if (operation === 'disconnectPresence') {
    validateNullableInteger(input, 'generationVersion', true);
    validateNullableInteger(input, 'observedExpiresAtEpochMs', true);
    validateNullableInteger(input, 'disconnectedAtEpochMs', true);
  }
  validateNullableInteger(input, 'lastHeartbeatAtEpochMs', true);
  validateNullableInteger(input, 'expiresAtEpochMs', true);
}

function validateNullableString(input: Readonly<Record<string, unknown>>, key: string): void {
  if (input[key] !== null) requireNonEmptyString(input[key], `Group ${key}`);
}

function validateNullableInteger(
  input: Readonly<Record<string, unknown>>,
  key: string,
  positive = false,
): void {
  const value = input[key];
  if (value === null) return;
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    throw new TypeError(`Group ${key} is invalid`);
  }
}

const GROUP_MUTATION_OPERATIONS = new Set([
  'createGroup',
  'updateGroup',
  'appointDirector',
  'startGroupEstablishment',
  'activateGroup',
  'reopenGroupEstablishment',
  'failGroupFormation',
  'joinGroup',
  'acceptGroupInvite',
  'createGroupInvite',
  'revokeGroupInvite',
  'rotateGroupJoinCode',
  'removeGroupMember',
  'banGroupMember',
  'unbanGroupMember',
  'setGroupMemberRole',
  'transferGroupOwnership',
  'upsertMember',
  'connectPresence',
  'heartbeatPresence',
  'disconnectPresence',
]);

const TARGET_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
  'joinGroup',
  'acceptGroupInvite',
  'createGroupInvite',
  'revokeGroupInvite',
  'removeGroupMember',
  'banGroupMember',
  'unbanGroupMember',
  'setGroupMemberRole',
  'transferGroupOwnership',
  'upsertMember',
]);

const PRESENCE_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
  'connectPresence',
  'heartbeatPresence',
  'disconnectPresence',
]);

const AGGREGATE_GROUP_MUTATION_OPERATIONS = new Set<GroupMutationCommand['operation']>([
  'createGroup',
  'updateGroup',
  'appointDirector',
  'rotateGroupJoinCode',
  'startGroupEstablishment',
  'activateGroup',
  'reopenGroupEstablishment',
  'failGroupFormation',
]);

const GROUP_MUTATION_INPUT_KEYS: Readonly<
  Record<GroupMutationCommand['operation'], readonly string[]>
> = {
  createGroup: [
    ...ACTOR_INPUT_KEYS,
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
    'lifecyclePolicy',
  ],
  updateGroup: [
    ...ACTOR_INPUT_KEYS,
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
  appointDirector: [...ACTOR_INPUT_KEYS, 'heartbeatTtlMs'],
  startGroupEstablishment: [...ACTOR_INPUT_KEYS],
  activateGroup: [...ACTOR_INPUT_KEYS, 'observedRate', 'degraded'],
  reopenGroupEstablishment: [...ACTOR_INPUT_KEYS],
  failGroupFormation: [...ACTOR_INPUT_KEYS, 'observedRate'],
  joinGroup: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
  acceptGroupInvite: [...ACTOR_INPUT_KEYS, 'inviteToken', 'joinCode'],
  createGroupInvite: [...ACTOR_INPUT_KEYS, 'invitationExpiresAtEpochMs'],
  revokeGroupInvite: ACTOR_INPUT_KEYS,
  removeGroupMember: ACTOR_INPUT_KEYS,
  banGroupMember: ACTOR_INPUT_KEYS,
  unbanGroupMember: ACTOR_INPUT_KEYS,
  setGroupMemberRole: [...ACTOR_INPUT_KEYS, 'role'],
  transferGroupOwnership: ACTOR_INPUT_KEYS,
  upsertMember: [
    ...ACTOR_INPUT_KEYS,
    'role',
    'status',
    'invitedByPrincipalId',
    'invitationExpiresAtEpochMs',
  ],
  rotateGroupJoinCode: [...ACTOR_INPUT_KEYS, 'joinCode', 'expiresAtEpochMs'],
  connectPresence: [
    ...ACTOR_INPUT_KEYS,
    'principalId',
    'generationId',
    'connectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
  heartbeatPresence: [
    ...ACTOR_INPUT_KEYS,
    'principalId',
    'generationId',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
  disconnectPresence: [
    ...ACTOR_INPUT_KEYS,
    'principalId',
    'generationId',
    'generationVersion',
    'observedExpiresAtEpochMs',
    'disconnectedAtEpochMs',
    'lastHeartbeatAtEpochMs',
    'expiresAtEpochMs',
  ],
};
