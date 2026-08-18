import type { GroupMutationCommand } from '../group-mutation-contracts.ts';
import {
  requireNonEmptyString,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
} from '../../group-state-validation-primitives.ts';

interface ValidateGroupMutationOperationInput {
  readonly operation: GroupMutationCommand['operation'];
  readonly input: Record<string, unknown>;
}

export function validateGroupMutationOperationInput({
  operation,
  input,
}: ValidateGroupMutationOperationInput): void {
  if (isAggregateOperation(operation)) {
    validateAggregateMutationInput(operation, input);
    return;
  }
  if (isPresenceOperation(operation)) return;
  validateMembershipMutationInput(operation, input);
}

type AggregateOperation = Extract<
  GroupMutationCommand['operation'],
  | 'createGroup'
  | 'updateGroup'
  | 'appointDirector'
  | 'rotateGroupJoinCode'
  | 'startGroupEstablishment'
  | 'activateGroup'
  | 'reopenGroupEstablishment'
  | 'failGroupFormation'
>;

function validateAggregateMutationInput(
  operation: AggregateOperation,
  input: Record<string, unknown>,
): void {
  const optionalString = (key: string) => {
    if (input[key] !== undefined) requireNonEmptyString(input[key], `Group ${operation} ${key}`);
  };
  const optionalPositiveInteger = (key: string) => {
    if (input[key] !== undefined) {
      requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
    }
  };
  if (operation === 'createGroup') {
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
  }
  if (operation === 'updateGroup') {
    validateGroupUpdateInput(input, optionalString, optionalPositiveInteger);
    return;
  }
  if (operation === 'appointDirector') {
    optionalPositiveInteger('heartbeatTtlMs');
    return;
  }
  if (operation === 'startGroupEstablishment' || operation === 'reopenGroupEstablishment') {
    return;
  }
  if (operation === 'activateGroup') {
    validateActivateGroupInput(input);
    return;
  }
  if (operation === 'failGroupFormation') {
    if (!isUnitIntervalNumber(input.observedRate)) {
      throw new TypeError('Group failGroupFormation observedRate must be within [0, 1]');
    }
    return;
  }
  optionalString('joinCode');
  optionalPositiveInteger('expiresAtEpochMs');
}

function validateGroupUpdateInput(
  input: Record<string, unknown>,
  optionalString: (key: string) => void,
  optionalPositiveInteger: (key: string) => void,
): void {
  optionalString('slug');
  optionalString('displayName');
  optionalString('description');
  if (input.kind !== undefined) {
    requireOneOf(input.kind, ['party', 'room', 'team', 'custom'], 'Group kind');
  }
  if (input.status !== undefined) {
    requireOneOf(input.status, ['active', 'archived', 'deleted'], 'Group status');
  }
  if (input.joinMode !== undefined) {
    requireOneOf(input.joinMode, ['invite-only', 'code', 'open'], 'Group joinMode');
  }
  optionalPositiveInteger('maxMembers');
  optionalPositiveInteger('maxSessionsPerMember');
  if (input.metadata !== undefined) requireRecord(input.metadata, 'Group metadata');
  optionalPositiveInteger('expiresAtEpochMs');
  optionalPositiveInteger('emptySinceEpochMs');
  optionalPositiveInteger('purgeAfterEpochMs');
}

type MembershipOperation = Exclude<
  GroupMutationCommand['operation'],
  AggregateOperation | 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence'
>;

function validateMembershipMutationInput(
  operation: MembershipOperation,
  input: Record<string, unknown>,
): void {
  const optionalString = (key: string) => {
    if (input[key] !== undefined) requireNonEmptyString(input[key], `Group ${operation} ${key}`);
  };
  const optionalPositiveInteger = (key: string) => {
    if (input[key] !== undefined) {
      requirePositiveSafeInteger(input[key], `Group ${operation} ${key}`);
    }
  };
  switch (operation) {
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
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
      return;
  }
}

function isAggregateOperation(
  operation: GroupMutationCommand['operation'],
): operation is AggregateOperation {
  return [
    'createGroup',
    'updateGroup',
    'appointDirector',
    'rotateGroupJoinCode',
    'startGroupEstablishment',
    'activateGroup',
    'reopenGroupEstablishment',
    'failGroupFormation',
  ].includes(operation);
}

type PresenceOperation = 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';

function isPresenceOperation(
  operation: GroupMutationCommand['operation'],
): operation is PresenceOperation {
  return ['connectPresence', 'heartbeatPresence', 'disconnectPresence'].includes(operation);
}

// This validator sees both raw requests and built commands. Requests never
// carry the criterion fields (the exact-key check excludes them), so absence,
// like null, means operator activation.
function validateActivateGroupInput(input: Record<string, unknown>): void {
  const { observedRate, degraded } = input;
  if (observedRate !== undefined && observedRate !== null && !isUnitIntervalNumber(observedRate)) {
    throw new TypeError('Group activateGroup observedRate must be within [0, 1]');
  }
  if (degraded !== undefined && degraded !== null && typeof degraded !== 'boolean') {
    throw new TypeError('Group activateGroup degraded must be boolean or null');
  }
}

function isUnitIntervalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
