import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateEntryValue } from '../../../../runtime-state/RuntimeStateJsonStore.ts';

import {
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
  groupStatePresenceSessionStorageKey,
  groupStatePresenceSummaryStorageKey,
} from '../../persistence/group-state-storage-keys.ts';
// prettier-ignore
import {
  validateGroupExpiredStateAuthority,
} from '../../presence/group-expired-state-authority.ts';
import type { GroupMutationCommand, GroupMutationRead } from '../group-mutation-contracts.ts';
// prettier-ignore
import {
  isGroupLifecycleTransitionOperation,
} from '../group-mutation-contracts.ts';
import {
  resolveGroupMutationReadIdentities,
  type GroupMutationReadIdentities,
} from '../read/resolve-group-mutation-read-identities.ts';
// prettier-ignore
import {
  validateGroupMutationIdempotencyRecord,
} from '../result-validation/validate-group-mutation-result.ts';
import {
  requireOneOf,
  assertExactKeys,
  assertRequiredKeys,
  requireJsonSafe,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireRecord,
} from '../../group-state-validation-primitives.ts';
import {
  validateStoredGroup,
  validateStoredMember,
} from '../../persistence/validate-persisted-group.ts';
import {
  validatePresenceAdmission,
  validatePresenceSession,
  validatePresenceSummaryValue,
} from '../../persistence/validate-persisted-group-presence.ts';

interface AdmissionReadValidationInput {
  readonly read: GroupMutationRead;
  readonly command: GroupMutationCommand;
  readonly ref: GroupRef;
  readonly identities: GroupMutationReadIdentities;
}

export function validateGroupMutationRead(
  read: GroupMutationRead,
  command: GroupMutationCommand,
): void {
  const ref = command.aggregateRef;
  validateReadShape(read);
  validateStoredGroupRead(read, ref);
  const identities = resolveGroupMutationReadIdentities(read, command);
  validateMemberReads(read, ref, identities);
  validateTargetPresenceRead(read, ref, identities);
  validateGroupExpiredStateAuthority({
    ref,
    targetSessionId: identities.targetSessionId,
    group: read.group,
    expiredGroupEntry: read.expiredGroupEntry,
    targetPresence: read.targetPresence,
    expiredTargetPresenceEntry: read.expiredTargetPresenceEntry,
  });
  validateAdmissionReads({ read, command, ref, identities });
  validateAuthorityPresenceReads(read, ref);
  validateSummaryAndIdempotencyReads(read, command, ref);
  validateLifecyclePolicyRead(read, command);
}

/**
 * The policy read is loaded exactly for the lifecycle transition operations;
 * anywhere else its presence would mean the read step loaded state the
 * operation must not depend on.
 */
function validateLifecyclePolicyRead(read: GroupMutationRead, command: GroupMutationCommand): void {
  if (isGroupLifecycleTransitionOperation(command.operation)) {
    if (read.lifecyclePolicy === null) {
      throw new TypeError('Group mutation read is missing the lifecycle policy read');
    }
    requireOneOf(
      read.lifecyclePolicy.status,
      ['absent', 'present', 'corrupt'],
      'Group mutation lifecycle policy status',
    );
    return;
  }
  if (read.lifecyclePolicy !== null) {
    throw new TypeError('Group mutation read must not carry a lifecycle policy for this operation');
  }
}

const GROUP_MUTATION_READ_KEYS = [
  'idempotency',
  'group',
  'actorMember',
  'targetMember',
  'authorityMember',
  'expiredGroupEntry',
  'expiredTargetPresenceEntry',
  'directorMember',
  'actorMemberEntry',
  'targetMemberEntry',
  'authorityMemberEntry',
  'directorMemberEntry',
  'targetPresence',
  'targetAdmission',
  'authorityAdmission',
  'directorAdmission',
  'authorityPresenceSessions',
  'authorityPresenceSessionEntries',
  'presenceSummary',
  'lifecyclePolicy',
] as const;

function validateReadShape(read: GroupMutationRead): void {
  requireJsonSafe(read, 'Group mutation read');
  assertExactKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read');
  assertRequiredKeys(read, GROUP_MUTATION_READ_KEYS, 'Group mutation read');
}

function validateStoredGroupRead(read: GroupMutationRead, ref: GroupRef): void {
  if (read.group) {
    validateRuntimeEntryValue(read.group, 'Stored group', groupStateGroupStorageKey(ref));
    validateStoredGroup(read.group.value, ref);
  }
}

function validateMemberReads(
  read: GroupMutationRead,
  ref: GroupRef,
  identities: GroupMutationReadIdentities,
): void {
  validateMemberReadPair({
    member: read.actorMember,
    stored: read.actorMemberEntry,
    ref,
    expectedPrincipalId: identities.actorPrincipalId,
    label: 'Actor member',
  });
  validateMemberReadPair({
    member: read.targetMember,
    stored: read.targetMemberEntry,
    ref,
    expectedPrincipalId: identities.targetPrincipalId,
    label: 'Target member',
  });
  validateMemberReadPair({
    member: read.authorityMember,
    stored: read.authorityMemberEntry,
    ref,
    expectedPrincipalId: identities.ownerPrincipalId,
    label: 'Authority member',
  });
  validateMemberReadPair({
    member: read.directorMember,
    stored: read.directorMemberEntry,
    ref,
    expectedPrincipalId: identities.directorPrincipalId,
    label: 'Director member',
  });
}

function validateTargetPresenceRead(
  read: GroupMutationRead,
  ref: GroupRef,
  identities: GroupMutationReadIdentities,
): void {
  const { targetSessionId, targetPrincipalId } = identities;
  if (read.targetPresence) {
    if (targetSessionId === null || read.targetPresence.value.sessionId !== targetSessionId) {
      throw new TypeError('Stored target presence session differs from command slot identity');
    }
    if (targetPrincipalId === null || read.targetPresence.value.principalId !== targetPrincipalId) {
      throw new TypeError('Stored target presence principal differs from command slot identity');
    }
    validateRuntimeEntryValue(
      read.targetPresence,
      'Stored target presence',
      groupStatePresenceSessionStorageKey({ ...ref, sessionId: targetSessionId }),
    );
    validatePresenceSession(read.targetPresence.value, ref, 'Stored target presence');
  }
}

function validateAdmissionReads({
  read,
  command,
  ref,
  identities,
}: AdmissionReadValidationInput): void {
  const authorityAdmissionPrincipalId =
    command.operation === 'appointDirector' ? identities.ownerPrincipalId : null;
  const directorAdmissionPrincipalId =
    command.operation === 'appointDirector' ? identities.directorPrincipalId : null;
  for (const [label, admission, expectedPrincipalId] of [
    ['Target admission', read.targetAdmission, identities.targetPrincipalId],
    ['Authority admission', read.authorityAdmission, authorityAdmissionPrincipalId],
    ['Director admission', read.directorAdmission, directorAdmissionPrincipalId],
  ] as const) {
    if (!admission) continue;
    if (expectedPrincipalId === null || admission.value.principalId !== expectedPrincipalId) {
      throw new TypeError(`${label} principal differs from command slot identity`);
    }
    validateRuntimeEntryValue(
      admission,
      label,
      groupStatePresenceAdmissionStorageKey({
        ...ref,
        principalId: expectedPrincipalId,
      }),
    );
    validatePresenceAdmission(admission.value, ref);
  }
}

function validateAuthorityPresenceReads(read: GroupMutationRead, ref: GroupRef): void {
  if (
    !Array.isArray(read.authorityPresenceSessions) ||
    !Array.isArray(read.authorityPresenceSessionEntries)
  ) {
    throw new TypeError('Authority presence sessions must be arrays');
  }
  if (read.authorityPresenceSessions.length !== read.authorityPresenceSessionEntries.length) {
    throw new TypeError('Authority presence sessions differ from stored entries');
  }
  const referencedAuthoritySessions = collectReferencedAuthoritySessions(read);
  validateAuthorityPresenceEntries(read, ref, referencedAuthoritySessions);
}

interface ReferencedAuthoritySession {
  readonly principalId: string;
  readonly generationId: string;
  readonly generationVersion: number;
  readonly connectedAtEpochMs: number;
}

function collectReferencedAuthoritySessions(
  read: GroupMutationRead,
): ReadonlyMap<string, ReferencedAuthoritySession> {
  const referencedAuthoritySessions = new Map<string, ReferencedAuthoritySession>();
  for (const admission of [read.authorityAdmission, read.directorAdmission]) {
    if (!admission) continue;
    for (const session of admission.value.admittedSessions) {
      const existing = referencedAuthoritySessions.get(session.sessionId);
      if (existing && existing.principalId !== admission.value.principalId) {
        throw new TypeError(
          'Stored authority presence session is referenced by multiple principals',
        );
      }
      if (
        existing &&
        (existing.generationId !== session.generationId ||
          existing.generationVersion !== session.generationVersion ||
          existing.connectedAtEpochMs !== session.connectedAtEpochMs)
      ) {
        throw new TypeError(
          'Stored authority presence session has conflicting admission generations',
        );
      }
      referencedAuthoritySessions.set(session.sessionId, {
        principalId: admission.value.principalId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        connectedAtEpochMs: session.connectedAtEpochMs,
      });
    }
  }
  return referencedAuthoritySessions;
}

function validateAuthorityPresenceEntries(
  read: GroupMutationRead,
  ref: GroupRef,
  referencedAuthoritySessions: ReadonlyMap<string, ReferencedAuthoritySession>,
): void {
  read.authorityPresenceSessionEntries.forEach((entry, index) => {
    const expected = referencedAuthoritySessions.get(entry.value.sessionId);
    if (
      !expected ||
      expected.principalId !== entry.value.principalId ||
      expected.generationId !== entry.value.generationId ||
      expected.generationVersion !== entry.value.generationVersion ||
      expected.connectedAtEpochMs !== entry.value.connectedAtEpochMs
    ) {
      throw new TypeError(
        'Stored authority presence is not referenced by its corresponding admission',
      );
    }
    validateRuntimeEntryValue(
      entry,
      'Stored authority presence',
      groupStatePresenceSessionStorageKey({
        ...ref,
        sessionId: entry.value.sessionId,
      }),
    );
    validatePresenceSession(entry.value, ref, 'Stored authority presence');
    if (!jsonEquals(entry.value, read.authorityPresenceSessions[index])) {
      throw new TypeError('Authority presence session differs from stored entry');
    }
  });
}

function validateSummaryAndIdempotencyReads(
  read: GroupMutationRead,
  command: GroupMutationCommand,
  ref: GroupRef,
): void {
  if (read.presenceSummary) {
    validateRuntimeEntryValue(
      read.presenceSummary,
      'Stored presence summary',
      groupStatePresenceSummaryStorageKey(ref),
    );
    validatePresenceSummaryValue(read.presenceSummary.value, ref);
  }
  if (read.idempotency) {
    if (command.requestId === null || read.idempotency.value.requestId !== command.requestId) {
      throw new TypeError('Stored group idempotency request differs from command identity');
    }
    validateRuntimeEntryValue(
      read.idempotency,
      'Stored group idempotency',
      groupStateIdempotencyStorageKey(ref, command.requestId),
    );
    validateGroupMutationIdempotencyRecord(read.idempotency.value, ref);
  }
}

export function validateRuntimeEntryValue<T>(
  stored: RuntimeStateEntryValue<T>,
  label: string,
  expectedKey?: string,
): void {
  const wrapper = requireRecord(stored, label);
  assertExactKeys(wrapper, ['entry', 'value'], label);
  assertRequiredKeys(wrapper, ['entry', 'value'], label);
  const entry = requireRecord(wrapper.entry, `${label} entry`);
  assertExactKeys(
    entry,
    ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
    `${label} entry`,
  );
  assertRequiredKeys(
    entry,
    ['key', 'value', 'expireAtTimestamp', 'updatedTimestamp', 'revision'],
    `${label} entry`,
  );
  requireNonEmptyString(entry.key, `${label} entry key`);
  if (expectedKey !== undefined && entry.key !== expectedKey) {
    throw new TypeError(`${label} entry key is not canonical for its identity`);
  }
  if (typeof entry.value !== 'string') {
    throw new TypeError(`${label} entry value must be serialized JSON`);
  }
  if (!Number.isSafeInteger(entry.expireAtTimestamp) || (entry.expireAtTimestamp as number) < 0) {
    throw new TypeError(`${label} expiry must be a non-negative safe integer`);
  }
  requireNonNegativeSafeInteger(entry.revision, `${label} revision`);
  requireNonEmptyString(entry.updatedTimestamp, `${label} updatedTimestamp`);
  if (Number.isNaN(Date.parse(entry.updatedTimestamp as string))) {
    throw new TypeError(`${label} updatedTimestamp must be an ISO timestamp`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.value as string);
  } catch {
    throw new TypeError(`${label} entry value must be valid JSON`);
  }
  if (!jsonEquals(parsed, wrapper.value)) {
    throw new TypeError(`${label} entry value differs from parsed value`);
  }
}

interface ValidateMemberReadPairInput {
  readonly member: GroupMember | null;
  readonly stored: RuntimeStateEntryValue<GroupMember> | null;
  readonly ref: GroupRef;
  readonly expectedPrincipalId: string | null;
  readonly label: string;
}

export function validateMemberReadPair({
  member,
  stored,
  ref,
  expectedPrincipalId,
  label,
}: ValidateMemberReadPairInput): void {
  if ((member === null) !== (stored === null)) {
    throw new TypeError(`${label} differs from stored entry presence`);
  }
  if (!member || !stored) return;
  if (expectedPrincipalId === null || member.principalId !== expectedPrincipalId) {
    throw new TypeError(`${label} principal differs from command slot identity`);
  }
  validateRuntimeEntryValue(
    stored,
    `Stored ${label.toLowerCase()}`,
    groupStateMemberStorageKey({ ...ref, principalId: expectedPrincipalId }),
  );
  validateStoredMember(stored.value, ref, label);
  if (!jsonEquals(member, stored.value)) {
    throw new TypeError(`${label} differs from stored entry value`);
  }
}
