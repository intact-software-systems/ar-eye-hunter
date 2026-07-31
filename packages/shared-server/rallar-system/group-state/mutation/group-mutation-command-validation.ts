import type { GroupMutationCommand } from './group-mutation-contracts.ts';
import { ACTOR_INPUT_KEYS } from './group-mutation-request-validation.ts';
import {
  assertExactKeys,
  requireJsonSafe,
  requireNonEmptyString,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
  validateGroupRef,
} from '../group-state-validation-primitives.ts';

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
  const nullableString = (key: string) => {
    if (input[key] !== null) requireNonEmptyString(input[key], `Group ${key}`);
  };
  const nullableInteger = (key: string, positive = false) => {
    const value = input[key];
    if (value === null) return;
    if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
      throw new TypeError(`Group ${key} is invalid`);
    }
  };
  switch (operation) {
    case 'createGroup':
      nullableString('slug');
      requireNonEmptyString(input.displayName, 'Group displayName');
      nullableString('description');
      requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      nullableInteger('maxMembers', true);
      nullableInteger('maxSessionsPerMember', true);
      requireRecord(input.metadata, 'Group metadata');
      requireNonEmptyString(input.createdByPrincipalId, 'Group createdByPrincipalId');
      nullableInteger('expiresAtEpochMs', true);
      nullableInteger('purgeAfterEpochMs', true);
      return;
    case 'updateGroup':
      nullableString('slug');
      nullableString('displayName');
      nullableString('description');
      if (input.kind !== null)
        requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
      if (input.status !== null)
        requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
      if (input.joinMode !== null)
        requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
      nullableInteger('maxMembers', true);
      nullableInteger('maxSessionsPerMember', true);
      if (input.metadata !== null) requireRecord(input.metadata, 'Group metadata');
      nullableInteger('expiresAtEpochMs', true);
      nullableInteger('emptySinceEpochMs', true);
      nullableInteger('purgeAfterEpochMs', true);
      return;
    case 'appointDirector':
      requirePositiveSafeInteger(input.heartbeatTtlMs, 'Group heartbeatTtlMs');
      return;
    case 'joinGroup':
    case 'acceptGroupInvite':
      nullableString('inviteToken');
      nullableString('joinCode');
      return;
    case 'createGroupInvite':
      nullableInteger('invitationExpiresAtEpochMs', true);
      return;
    case 'setGroupMemberRole':
      requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      return;
    case 'upsertMember':
      if (input.role !== null) requireOneOf(input.role, ['owner', 'admin', 'member'], 'Group role');
      requireOneOf(
        input.status,
        ['invited', 'active', 'left', 'removed', 'banned'],
        'Group member status',
      );
      nullableString('invitedByPrincipalId');
      nullableInteger('invitationExpiresAtEpochMs', true);
      return;
    case 'rotateGroupJoinCode':
      nullableString('joinCode');
      nullableInteger('expiresAtEpochMs', true);
      return;
    case 'connectPresence':
      requireNonEmptyString(input.principalId, 'Group presence principalId');
      nullableInteger('connectedAtEpochMs', true);
      nullableInteger('lastHeartbeatAtEpochMs', true);
      nullableInteger('expiresAtEpochMs', true);
      return;
    case 'heartbeatPresence':
      nullableString('principalId');
      nullableInteger('lastHeartbeatAtEpochMs', true);
      nullableInteger('expiresAtEpochMs', true);
      return;
    case 'disconnectPresence':
      nullableString('principalId');
      nullableInteger('generationVersion', true);
      nullableInteger('observedExpiresAtEpochMs', true);
      nullableInteger('disconnectedAtEpochMs', true);
      nullableInteger('lastHeartbeatAtEpochMs', true);
      nullableInteger('expiresAtEpochMs', true);
      return;
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
    case 'transferGroupOwnership':
      return;
  }
}

const GROUP_MUTATION_OPERATIONS = new Set([
  'createGroup',
  'updateGroup',
  'appointDirector',
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
