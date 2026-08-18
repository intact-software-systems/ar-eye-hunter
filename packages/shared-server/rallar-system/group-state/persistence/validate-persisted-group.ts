import type {
  AuditStamp,
  Group,
  GroupMember,
  GroupRef,
  GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import {
  assertExactKeys,
  assertRequiredKeys,
  nullableNonEmptyString,
  nullablePositiveSafeInteger,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireOneOf,
  requirePositiveSafeInteger,
  requireRecord,
} from '../group-state-validation-primitives.ts';

const STORED_GROUP_KEYS = [
  'applicationId',
  'workspaceId',
  'groupId',
  'slug',
  'displayName',
  'description',
  'kind',
  'status',
  'joinMode',
  'maxMembers',
  'maxSessionsPerMember',
  'metadata',
  'activeMemberCount',
  'ownerPrincipalId',
  'snapshotVersion',
  'metadataVersion',
  'rosterVersion',
  'presenceVersion',
  'created',
  'updated',
  'archived',
  'deleted',
  'expiresAtEpochMs',
  'emptySinceEpochMs',
  'purgeAfterEpochMs',
  'lifecycleState',
] as const;

const STORED_MEMBER_KEYS = [
  'applicationId',
  'workspaceId',
  'groupId',
  'principalId',
  'role',
  'status',
  'joined',
  'updated',
  'left',
  'removed',
  'banned',
  'invitedByPrincipalId',
  'invitationExpiresAtEpochMs',
] as const;

export function validateStoredGroup(group: unknown, ref: GroupRef): asserts group is Group {
  const value = requireRecord(group, 'Stored group value');
  assertExactKeys(value, STORED_GROUP_KEYS, 'Stored group value');
  assertRequiredKeys(value, STORED_GROUP_KEYS, 'Stored group value');
  validateScopedRecord(value, ref, 'Stored group');
  nullableNonEmptyString(value.slug, 'Stored group slug');
  requireNonEmptyString(value.displayName, 'Stored group displayName');
  nullableNonEmptyString(value.description, 'Stored group description');
  requireOneOf(value.kind, ['party', 'room', 'team', 'custom'], 'Stored group kind');
  requireOneOf(value.status, ['active', 'archived', 'deleted'], 'Stored group status');
  requireOneOf(value.joinMode, ['invite-only', 'code', 'open'], 'Stored group joinMode');
  nullablePositiveSafeInteger(value.maxMembers, 'Stored group maxMembers');
  nullablePositiveSafeInteger(value.maxSessionsPerMember, 'Stored group maxSessionsPerMember');
  requireRecord(value.metadata, 'Stored group metadata');
  requirePositiveSafeInteger(value.activeMemberCount, 'Stored group activeMemberCount');
  requireNonEmptyString(value.ownerPrincipalId, 'Stored group ownerPrincipalId');
  requirePositiveSafeInteger(value.snapshotVersion, 'Stored group snapshotVersion');
  requirePositiveSafeInteger(value.metadataVersion, 'Stored group metadataVersion');
  requirePositiveSafeInteger(value.rosterVersion, 'Stored group rosterVersion');
  requireNonNegativeSafeInteger(value.presenceVersion, 'Stored group presenceVersion');
  validateAuditStamp(value.created, 'Stored group created');
  validateAuditStamp(value.updated, 'Stored group updated');
  if (value.archived !== null) validateAuditStamp(value.archived, 'Stored group archived');
  if (value.deleted !== null) validateAuditStamp(value.deleted, 'Stored group deleted');
  if (value.status === 'active' && (value.archived !== null || value.deleted !== null)) {
    throw new TypeError('Stored active group lifecycle fields must be null');
  }
  if (value.status === 'archived' && (value.archived === null || value.deleted !== null)) {
    throw new TypeError('Stored archived group lifecycle fields are invalid');
  }
  if (value.status === 'deleted' && value.deleted === null) {
    throw new TypeError('Stored deleted group is missing lifecycle audit');
  }
  nullablePositiveSafeInteger(value.expiresAtEpochMs, 'Stored group expiresAtEpochMs');
  nullablePositiveSafeInteger(value.emptySinceEpochMs, 'Stored group emptySinceEpochMs');
  nullablePositiveSafeInteger(value.purgeAfterEpochMs, 'Stored group purgeAfterEpochMs');
}

export function validateStoredMember(
  member: unknown,
  ref: GroupRef,
  label: string,
): asserts member is GroupMember {
  const value = requireRecord(member, `${label} value`);
  assertExactKeys(value, STORED_MEMBER_KEYS, `${label} value`);
  assertRequiredKeys(value, STORED_MEMBER_KEYS, `${label} value`);
  validateScopedRecord(value, ref, label);
  requireNonEmptyString(value.principalId, `${label} principalId`);
  requireOneOf(value.role, ['owner', 'admin', 'member'], `${label} role`);
  requireOneOf(value.status, ['invited', 'active', 'left', 'removed', 'banned'], `${label} status`);
  if (value.joined !== null) validateAuditStamp(value.joined, `${label} joined`);
  validateAuditStamp(value.updated, `${label} updated`);
  for (const key of ['left', 'removed', 'banned'] as const) {
    if (value[key] !== null) validateAuditStamp(value[key], `${label} ${key}`);
  }
  const lifecycleKey =
    value.status === 'left'
      ? 'left'
      : value.status === 'removed'
        ? 'removed'
        : value.status === 'banned'
          ? 'banned'
          : null;
  for (const terminal of ['left', 'removed', 'banned'] as const) {
    if ((terminal === lifecycleKey) !== (value[terminal] !== null)) {
      throw new TypeError(`${label} terminal lifecycle audits are inconsistent`);
    }
  }
  if (value.status === 'invited' && value.joined !== null) {
    throw new TypeError(`${label} invited member joined must be null`);
  }
  if (value.status === 'active' && value.joined === null) {
    throw new TypeError(`${label} active member joined is required`);
  }
  nullableNonEmptyString(value.invitedByPrincipalId, `${label} invitedByPrincipalId`);
  nullablePositiveSafeInteger(
    value.invitationExpiresAtEpochMs,
    `${label} invitationExpiresAtEpochMs`,
  );
}

export function validatePersistedGroup(value: unknown, ref: GroupRef): asserts value is Group {
  validateStoredGroup(value, ref);
}

export function validatePersistedGroupMember(
  value: unknown,
  ref: GroupRef,
): asserts value is GroupMember {
  validateStoredMember(value, ref, 'Stored group member');
}

export function validateScopedValue(
  value: Pick<GroupRef, 'applicationId' | 'workspaceId' | 'groupId'>,
  ref: GroupRef,
  label: string,
): void {
  requireNonEmptyString(value.applicationId, `${label} applicationId`);
  requireNonEmptyString(value.groupId, `${label} groupId`);
  if (value.workspaceId !== undefined) {
    requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
  }
  if (
    value.applicationId !== ref.applicationId ||
    value.workspaceId !== ref.workspaceId ||
    value.groupId !== ref.groupId
  ) {
    throw new TypeError(`${label} scope differs from mutation group`);
  }
}

export function validateScopedRecord(
  value: Readonly<Record<string, unknown>>,
  ref: GroupRef,
  label: string,
): void {
  requireNonEmptyString(value.applicationId, `${label} applicationId`);
  requireNonEmptyString(value.workspaceId, `${label} workspaceId`);
  requireNonEmptyString(value.groupId, `${label} groupId`);
  if (
    value.applicationId !== ref.applicationId ||
    value.workspaceId !== ref.workspaceId ||
    value.groupId !== ref.groupId
  ) {
    throw new TypeError(`${label} scope differs from mutation group`);
  }
}

export function validateAuditStamp(value: unknown, label: string): asserts value is AuditStamp {
  const audit = requireRecord(value, label);
  assertExactKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label);
  assertRequiredKeys(audit, ['atEpochMs', 'actor', 'reason', 'traceId', 'requestId'], label);
  requireNonNegativeSafeInteger(audit.atEpochMs, `${label} atEpochMs`);
  validateMutationActor(audit.actor, `${label} actor`);
  nullableNonEmptyString(audit.reason, `${label} reason`);
  nullableNonEmptyString(audit.traceId, `${label} traceId`);
  nullableNonEmptyString(audit.requestId, `${label} requestId`);
}

export function validateMutationActor(
  value: unknown,
  label: string,
): asserts value is MutationActor {
  const actor = requireRecord(value, label);
  requireOneOf(actor.kind, ['principal', 'session', 'service'], `${label} kind`);
  const keys =
    actor.kind === 'principal'
      ? ['kind', 'principalId']
      : actor.kind === 'session'
        ? ['kind', 'sessionId', 'principalId']
        : ['kind', 'serviceId'];
  assertExactKeys(actor, keys, label);
  assertRequiredKeys(actor, keys, label);
  for (const key of keys.filter((key) => key !== 'kind')) {
    requireNonEmptyString(actor[key], `${label} ${key}`);
  }
}

export function validateCausalRevision(
  value: unknown,
  label: string,
): asserts value is GroupStateCausalRevision {
  const revision = requireRecord(value, `${label} causalRevision`);
  assertExactKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`);
  assertRequiredKeys(revision, ['groupRevision', 'presenceRevision'], `${label} causalRevision`);
  requireNonNegativeSafeInteger(revision.groupRevision, `${label} groupRevision`);
  requireNonNegativeSafeInteger(revision.presenceRevision, `${label} presenceRevision`);
}
