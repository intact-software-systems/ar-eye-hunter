import type { GroupPresenceAdmission, GroupPresenceSession, GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

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
import { validateCausalRevision, validateScopedRecord } from './validate-persisted-group.ts';

export function validatePresenceSession(session: unknown, ref: GroupRef, label: string): asserts session is GroupPresenceSession {
  const value = requireRecord(session, `${label} value`);
  assertExactKeys(
    value,
    [
      'applicationId',
      'workspaceId',
      'groupId',
      'sessionId',
      'principalId',
      'generationId',
      'generationVersion',
      'connectedAtEpochMs',
      'lastHeartbeatAtEpochMs',
      'expiresAtEpochMs',
      'disconnectedAtEpochMs',
      'disconnectReason',
      'status',
    ],
    `${label} value`,
  );
  assertRequiredKeys(
    value,
    [
      'applicationId',
      'workspaceId',
      'groupId',
      'sessionId',
      'principalId',
      'generationId',
      'status',
      'generationVersion',
      'connectedAtEpochMs',
      'lastHeartbeatAtEpochMs',
      'expiresAtEpochMs',
      'disconnectedAtEpochMs',
      'disconnectReason',
    ],
    `${label} value`,
  );
  validateScopedRecord(value, ref, label);
  requireNonEmptyString(value.sessionId, `${label} sessionId`);
  requireNonEmptyString(value.principalId, `${label} principalId`);
  requireNonEmptyString(value.generationId, `${label} generationId`);
  requirePositiveSafeInteger(value.connectedAtEpochMs, 'Stored presence connectedAtEpochMs');
  requirePositiveSafeInteger(value.generationVersion, 'Stored presence generationVersion');
  if (value.generationVersion !== value.connectedAtEpochMs) {
    throw new TypeError('Stored presence generation order is ambiguous');
  }
  requirePositiveSafeInteger(value.lastHeartbeatAtEpochMs, `${label} lastHeartbeatAtEpochMs`);
  requirePositiveSafeInteger(value.expiresAtEpochMs, `${label} expiresAtEpochMs`);
  if (value.lastHeartbeatAtEpochMs < value.connectedAtEpochMs || value.expiresAtEpochMs < value.lastHeartbeatAtEpochMs) {
    throw new TypeError(`${label} timestamps are causally inconsistent`);
  }
  requireOneOf(value.status, ['active', 'disconnected'], `${label} status`);
  nullablePositiveSafeInteger(value.disconnectedAtEpochMs, `${label} disconnectedAtEpochMs`);
  nullableNonEmptyString(value.disconnectReason, `${label} disconnectReason`);
  if (value.disconnectedAtEpochMs !== null && value.disconnectedAtEpochMs < value.lastHeartbeatAtEpochMs) {
    throw new TypeError(`${label} disconnect predates heartbeat`);
  }
  if (value.status === 'active' && (value.disconnectedAtEpochMs !== null || value.disconnectReason !== null)) {
    throw new TypeError(`${label} active disconnect fields must be null`);
  }
  if (value.status === 'disconnected' && (value.disconnectedAtEpochMs === null || value.disconnectReason === null)) {
    throw new TypeError(`${label} disconnect lifecycle fields differ`);
  }
}

export function validatePersistedGroupPresenceSession(value: unknown, ref: GroupRef): asserts value is GroupPresenceSession {
  validatePresenceSession(value, ref, 'Stored group presence session');
}

export function validatePersistedGroupPresenceSummary(value: unknown, ref: GroupRef): asserts value is GroupPresenceSummary {
  validatePresenceSummaryValue(value, ref);
}

export function validatePersistedGroupPresenceAdmission(value: unknown, ref: GroupRef): asserts value is GroupPresenceAdmission {
  validatePresenceAdmission(value, ref);
}

export function validatePresenceSummaryValue(summary: unknown, ref: GroupRef): asserts summary is GroupPresenceSummary {
  const value = requireRecord(summary, 'Stored presence summary value');
  assertExactKeys(
    value,
    [
      'applicationId',
      'workspaceId',
      'groupId',
      'causalRevision',
      'activePrincipalIds',
      'activeSessionIds',
      'activeSessions',
      'activePrincipalCount',
      'activeSessionCount',
      'computedAtEpochMs',
    ],
    'Stored presence summary value',
  );
  assertRequiredKeys(
    value,
    [
      'applicationId',
      'workspaceId',
      'groupId',
      'causalRevision',
      'activePrincipalIds',
      'activeSessionIds',
      'activeSessions',
      'activePrincipalCount',
      'activeSessionCount',
      'computedAtEpochMs',
    ],
    'Stored presence summary value',
  );
  validateScopedRecord(value, ref, 'Stored presence summary');
  validateCausalRevision(value.causalRevision, 'Stored presence summary');
  if (!Array.isArray(value.activePrincipalIds) || !Array.isArray(value.activeSessionIds) || !Array.isArray(value.activeSessions)) {
    throw new TypeError('Stored presence summary collections must be arrays');
  }
  for (const principalId of value.activePrincipalIds) {
    requireNonEmptyString(principalId, 'Stored presence summary principalId');
  }
  for (const sessionId of value.activeSessionIds) {
    requireNonEmptyString(sessionId, 'Stored presence summary sessionId');
  }
  const activeSessions: GroupPresenceSession[] = [];
  for (const session of value.activeSessions) {
    validatePresenceSession(session, ref, 'Stored presence summary session');
    activeSessions.push(session);
  }
  requireNonNegativeSafeInteger(value.activePrincipalCount, 'Stored presence summary activePrincipalCount');
  requireNonNegativeSafeInteger(value.activeSessionCount, 'Stored presence summary activeSessionCount');
  requirePositiveSafeInteger(value.computedAtEpochMs, 'Stored presence summary computedAtEpochMs');
  const canonicalSessions = activeSessions.toSorted(
    (left, right) => left.sessionId.localeCompare(right.sessionId) || left.generationVersion - right.generationVersion,
  );
  const canonicalPrincipals = [...new Set(activeSessions.map((session) => session.principalId))].toSorted();
  if (
    value.activePrincipalCount !== value.activePrincipalIds.length ||
    value.activeSessionCount !== value.activeSessionIds.length ||
    value.activeSessionCount !== activeSessions.length ||
    !jsonEquals(value.activePrincipalIds, canonicalPrincipals) ||
    !jsonEquals(activeSessions, canonicalSessions) ||
    !jsonEquals(
      value.activeSessionIds,
      activeSessions.map((session) => session.sessionId),
    )
  ) {
    throw new TypeError('Stored presence summary facts are inconsistent');
  }
}

export function validatePresenceAdmission(admission: unknown, ref?: GroupRef): asserts admission is GroupPresenceAdmission {
  const value = requireRecord(admission, 'Presence admission');
  assertExactKeys(value, ['applicationId', 'workspaceId', 'groupId', 'principalId', 'admittedSessions', 'updatedAtEpochMs'], 'Presence admission');
  assertRequiredKeys(value, ['applicationId', 'workspaceId', 'groupId', 'principalId', 'admittedSessions', 'updatedAtEpochMs'], 'Presence admission');
  if (ref) validateScopedRecord(value, ref, 'Presence admission');
  requireNonEmptyString(value.principalId, 'Presence admission principalId');
  requirePositiveSafeInteger(value.updatedAtEpochMs, 'Presence admission updatedAtEpochMs');
  if (!Array.isArray(value.admittedSessions)) {
    throw new TypeError('Presence admission sessions must be an array');
  }
  const sessionIdentities: Array<
    Readonly<{
      sessionId: string;
      generationId: string;
      generationVersion: number;
      connectedAtEpochMs: number;
    }>
  > = [];
  const sessionIds = new Set<string>();
  for (const session of value.admittedSessions) {
    const sessionValue = requireRecord(session, 'Presence admission session');
    assertExactKeys(sessionValue, ['sessionId', 'generationId', 'generationVersion', 'connectedAtEpochMs'], 'Presence admission session');
    assertRequiredKeys(sessionValue, ['sessionId', 'generationId', 'generationVersion', 'connectedAtEpochMs'], 'Presence admission session');
    requireNonEmptyString(sessionValue.sessionId, 'Presence admission sessionId');
    requireNonEmptyString(sessionValue.generationId, 'Presence admission generationId');
    requirePositiveSafeInteger(sessionValue.generationVersion, 'Presence admission generationVersion');
    requirePositiveSafeInteger(sessionValue.connectedAtEpochMs, 'Presence admission connectedAtEpochMs');
    if (sessionValue.generationVersion !== sessionValue.connectedAtEpochMs) {
      throw new TypeError('Presence admission generation version is ambiguous');
    }
    if (sessionIds.has(sessionValue.sessionId)) {
      throw new TypeError('Presence admission sessionId must be unique');
    }
    sessionIds.add(sessionValue.sessionId);
    sessionIdentities.push({
      sessionId: sessionValue.sessionId,
      generationId: sessionValue.generationId,
      generationVersion: sessionValue.generationVersion,
      connectedAtEpochMs: sessionValue.connectedAtEpochMs,
    });
  }
  const canonical = sessionIdentities.toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
  if (!jsonEquals(canonical, sessionIdentities)) {
    throw new TypeError('Presence admission sessions must be canonically sorted');
  }
}

export function validateStoredGeneration(session: GroupPresenceSession): void {
  validateStoredGenerationValues(session.connectedAtEpochMs, session.generationVersion);
}

export function validateStoredGenerationValues(connectedAtEpochMs: unknown, generationVersion: unknown): void {
  requirePositiveSafeInteger(connectedAtEpochMs, 'Stored presence connectedAtEpochMs');
  requirePositiveSafeInteger(generationVersion, 'Stored presence generationVersion');
  if (generationVersion !== connectedAtEpochMs) {
    throw new TypeError('Stored presence generation order is ambiguous');
  }
}

export function compareGenerationOrder(left: readonly [number, string], right: readonly [number, string]): number {
  return Math.sign(left[0] - right[0]) || left[1].localeCompare(right[1]);
}
