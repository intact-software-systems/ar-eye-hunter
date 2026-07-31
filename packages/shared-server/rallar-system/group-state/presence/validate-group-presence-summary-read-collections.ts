import type { GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';

import { validateRuntimeEntryValue } from '../mutation/validate-group-mutation-read.ts';
import {
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
  groupStatePresenceSessionStorageKey,
} from '../persistence/group-state-storage-keys.ts';
import { validateStoredMember } from '../persistence/validate-persisted-group.ts';
import {
  validatePresenceAdmission,
  validatePresenceSession,
} from '../persistence/validate-persisted-group-presence.ts';
import type { GroupPresenceSummaryRead } from './compute-group-presence-summary.ts';

export function validateGroupPresenceSummaryReadCollections(
  ref: GroupRef,
  read: GroupPresenceSummaryRead,
): void {
  for (const [label, values] of [
    ['members', read.members],
    ['admissions', read.admissions],
    ['presence sessions', read.presenceSessions],
  ] as const) {
    if (!Array.isArray(values)) {
      throw new TypeError(`Group presence summary ${label} must be an array`);
    }
  }
  validateGroupPresenceSummaryMembers(ref, read);
  validateGroupPresenceSummaryAdmissions(ref, read.admissions);
  const sessionsById = validateGroupPresenceSummarySessions(ref, read.presenceSessions);
  validateGroupPresenceSummaryAdmissionSessions(read.admissions, sessionsById);
}

function validateGroupPresenceSummaryMembers(ref: GroupRef, read: GroupPresenceSummaryRead): void {
  const memberIds = new Set<string>();
  for (const stored of read.members) {
    validateRuntimeEntryValue(
      stored,
      'Stored summary member',
      groupStateMemberStorageKey({ ...ref, principalId: stored.value.principalId }),
    );
    validateStoredMember(stored.value, ref, 'Stored summary member');
    if (memberIds.has(stored.value.principalId)) {
      throw new TypeError('Group presence summary member principal is duplicated');
    }
    memberIds.add(stored.value.principalId);
  }
  const activeMembers = read.members
    .map(({ value }) => value)
    .filter((member) => member.status === 'active');
  const activeOwners = activeMembers.filter((member) => member.role === 'owner');
  if (
    read.group.value.activeMemberCount !== activeMembers.length ||
    activeOwners.length !== 1 ||
    activeOwners[0]?.principalId !== read.group.value.ownerPrincipalId
  ) {
    throw new TypeError('Group presence summary roster facts are inconsistent');
  }
}

function validateGroupPresenceSummaryAdmissions(
  ref: GroupRef,
  admissions: GroupPresenceSummaryRead['admissions'],
): void {
  const admissionPrincipals = new Set<string>();
  const admittedSessionOwners = new Map<string, string>();
  for (const stored of admissions) {
    validateRuntimeEntryValue(
      stored,
      'Stored summary admission',
      groupStatePresenceAdmissionStorageKey({ ...ref, principalId: stored.value.principalId }),
    );
    validatePresenceAdmission(stored.value, ref);
    if (admissionPrincipals.has(stored.value.principalId)) {
      throw new TypeError('Group presence summary admission principal is duplicated');
    }
    admissionPrincipals.add(stored.value.principalId);
    for (const session of stored.value.admittedSessions) {
      const existing = admittedSessionOwners.get(session.sessionId);
      if (existing !== undefined && existing !== stored.value.principalId) {
        throw new TypeError('Group presence summary session has multiple principals');
      }
      admittedSessionOwners.set(session.sessionId, stored.value.principalId);
    }
  }
}

function validateGroupPresenceSummarySessions(
  ref: GroupRef,
  presenceSessions: GroupPresenceSummaryRead['presenceSessions'],
): Map<string, GroupPresenceSession> {
  const sessionsById = new Map<string, GroupPresenceSession>();
  for (const stored of presenceSessions) {
    validateRuntimeEntryValue(
      stored,
      'Stored summary presence session',
      groupStatePresenceSessionStorageKey({ ...ref, sessionId: stored.value.sessionId }),
    );
    validatePresenceSession(stored.value, ref, 'Stored summary presence session');
    if (sessionsById.has(stored.value.sessionId)) {
      throw new TypeError('Group presence summary sessionId is duplicated');
    }
    sessionsById.set(stored.value.sessionId, stored.value);
  }
  return sessionsById;
}

function validateGroupPresenceSummaryAdmissionSessions(
  admissions: GroupPresenceSummaryRead['admissions'],
  sessionsById: ReadonlyMap<string, GroupPresenceSession>,
): void {
  for (const stored of admissions) {
    for (const admitted of stored.value.admittedSessions) {
      const session = sessionsById.get(admitted.sessionId);
      if (!session) continue;
      if (
        session.principalId !== stored.value.principalId ||
        session.generationId !== admitted.generationId ||
        session.generationVersion !== admitted.generationVersion ||
        session.connectedAtEpochMs !== admitted.connectedAtEpochMs
      ) {
        throw new TypeError('Group presence summary admission differs from stored generation');
      }
    }
  }
}
