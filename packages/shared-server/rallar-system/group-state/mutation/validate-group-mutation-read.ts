import { readRallarGroupDirectorAppointment } from '@shared/api/group-director.ts';
import type { GroupMember, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';

import {
  groupStateGroupStorageKey,
  groupStateIdempotencyStorageKey,
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
  groupStatePresenceSessionStorageKey,
  groupStatePresenceSummaryStorageKey,
} from '../../group-state-storage-keys.ts';
import { validateGroupExpiredStateAuthority } from '../../services/group-expired-state-authority.ts';
import type { GroupMutationCommand, GroupMutationRead } from './group-mutation-contracts.ts';
import { validateGroupMutationIdempotencyRecord } from './group-mutation-result.ts';
import {
  assertExactKeys,
  assertRequiredKeys,
  requireJsonSafe,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireRecord,
} from '../group-state-validation-primitives.ts';
import {
  validateStoredGroup,
  validateStoredMember,
} from '../persistence/validate-persisted-group.ts';
import {
  validatePresenceAdmission,
  validatePresenceSession,
  validatePresenceSummaryValue,
} from '../persistence/validate-persisted-group-presence.ts';

export function validateGroupMutationRead(
  read: GroupMutationRead,
  command: GroupMutationCommand,
): void {
  const ref = command.aggregateRef;
  requireJsonSafe(read, 'Group mutation read');
  assertExactKeys(
    read as unknown as Record<string, unknown>,
    [
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
    ],
    'Group mutation read',
  );
  assertRequiredKeys(
    read as unknown as Record<string, unknown>,
    [
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
    ],
    'Group mutation read',
  );
  if (read.group) {
    validateRuntimeEntryValue(read.group, 'Stored group', groupStateGroupStorageKey(ref));
    validateStoredGroup(read.group.value, ref);
  }
  const actorPrincipalId = command.input.actorPrincipalId;
  const targetPrincipalId = mutationTargetPrincipalId(command);
  const ownerPrincipalId = read.group?.value.ownerPrincipalId ?? null;
  const directorPrincipalId =
    readRallarGroupDirectorAppointment(read.group?.value.metadata)?.principalId ?? null;
  validateMemberReadPair(
    read.actorMember,
    read.actorMemberEntry,
    ref,
    actorPrincipalId,
    'Actor member',
  );
  validateMemberReadPair(
    read.targetMember,
    read.targetMemberEntry,
    ref,
    targetPrincipalId,
    'Target member',
  );
  validateMemberReadPair(
    read.authorityMember,
    read.authorityMemberEntry,
    ref,
    ownerPrincipalId,
    'Authority member',
  );
  validateMemberReadPair(
    read.directorMember,
    read.directorMemberEntry,
    ref,
    directorPrincipalId,
    'Director member',
  );
  const targetSessionId = mutationTargetSessionId(command);
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
  validateGroupExpiredStateAuthority({
    ref,
    targetSessionId,
    group: read.group,
    expiredGroupEntry: read.expiredGroupEntry,
    targetPresence: read.targetPresence,
    expiredTargetPresenceEntry: read.expiredTargetPresenceEntry,
  });
  const authorityAdmissionPrincipalId =
    command.operation === 'appointDirector' ? ownerPrincipalId : null;
  const directorAdmissionPrincipalId =
    command.operation === 'appointDirector' ? directorPrincipalId : null;
  for (const [label, admission, expectedPrincipalId] of [
    ['Target admission', read.targetAdmission, targetPrincipalId],
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
  if (
    !Array.isArray(read.authorityPresenceSessions) ||
    !Array.isArray(read.authorityPresenceSessionEntries)
  ) {
    throw new TypeError('Authority presence sessions must be arrays');
  }
  if (read.authorityPresenceSessions.length !== read.authorityPresenceSessionEntries.length) {
    throw new TypeError('Authority presence sessions differ from stored entries');
  }
  const referencedAuthoritySessions = new Map<
    string,
    Readonly<{
      principalId: string;
      generationId: string;
      generationVersion: number;
      connectedAtEpochMs: number;
    }>
  >();
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

export function validateMemberReadPair(
  member: GroupMember | null,
  stored: RuntimeStateEntryValue<GroupMember> | null,
  ref: GroupRef,
  expectedPrincipalId: string | null,
  label: string,
): void {
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

export function mutationTargetPrincipalId(command: GroupMutationCommand): string | null {
  if ('targetPrincipalId' in command) return command.targetPrincipalId;
  if (command.operation === 'connectPresence') return command.input.principalId;
  if (command.operation === 'heartbeatPresence' || command.operation === 'disconnectPresence') {
    return command.input.principalId ?? command.input.actorPrincipalId;
  }
  return command.input.actorPrincipalId;
}

export function mutationTargetSessionId(command: GroupMutationCommand): string | null {
  if ('sessionId' in command) return command.sessionId;
  return command.operation === 'appointDirector' ? command.input.actorSessionId : null;
}
