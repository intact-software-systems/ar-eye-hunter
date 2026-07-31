import type { AuditStamp, Group, GroupMember, GroupPresenceAdmission, GroupPresenceSession, GroupPresenceSummary, GroupRef } from '@shared/api/group-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import { assertExactKeys, requireRecord } from '../group-state-validation-primitives.ts';
import { validateAuditStamp, validateMutationActor, validatePersistedGroup, validatePersistedGroupMember } from './validate-persisted-group.ts';
import {
  validatePersistedGroupPresenceAdmission,
  validatePersistedGroupPresenceSession,
  validatePersistedGroupPresenceSummary,
} from './validate-persisted-group-presence.ts';

export function normalizePersistedGroup(value: unknown, ref: GroupRef): Group {
  const legacy = requireRecord(value, 'Stored group value');
  assertExactKeys(
    legacy,
    [
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
    ],
    'Stored group value',
  );
  const canonical: unknown = {
    applicationId: legacy.applicationId,
    workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
    groupId: legacy.groupId,
    slug: persistedOrDefault(legacy, 'slug', null),
    displayName: legacy.displayName,
    description: persistedOrDefault(legacy, 'description', null),
    kind: legacy.kind,
    status: legacy.status,
    joinMode: legacy.joinMode,
    maxMembers: persistedOrDefault(legacy, 'maxMembers', null),
    maxSessionsPerMember: persistedOrDefault(legacy, 'maxSessionsPerMember', null),
    metadata: legacy.metadata,
    activeMemberCount: legacy.activeMemberCount,
    ownerPrincipalId: legacy.ownerPrincipalId,
    snapshotVersion: legacy.snapshotVersion,
    metadataVersion: legacy.metadataVersion,
    rosterVersion: legacy.rosterVersion,
    presenceVersion: legacy.presenceVersion,
    created: normalizePersistedGroupAudit(legacy.created, 'Stored group created'),
    updated: normalizePersistedGroupAudit(legacy.updated, 'Stored group updated'),
    archived: normalizeOptionalPersistedGroupAudit(legacy, 'archived', 'Stored group archived'),
    deleted: normalizeOptionalPersistedGroupAudit(legacy, 'deleted', 'Stored group deleted'),
    expiresAtEpochMs: persistedOrDefault(legacy, 'expiresAtEpochMs', null),
    emptySinceEpochMs: persistedOrDefault(legacy, 'emptySinceEpochMs', null),
    purgeAfterEpochMs: persistedOrDefault(legacy, 'purgeAfterEpochMs', null),
  };
  validatePersistedGroup(canonical, ref);
  return canonical;
}

export function normalizePersistedGroupMember(value: unknown, ref: GroupRef): GroupMember {
  const legacy = requireRecord(value, 'Stored group member');
  assertExactKeys(
    legacy,
    [
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
    ],
    'Stored group member',
  );
  const status = legacy.status;
  const joined =
    status === 'invited' ? null : Object.hasOwn(legacy, 'joined') ? normalizeNullablePersistedGroupAudit(legacy.joined, 'Stored member joined') : null;
  const canonical: unknown = {
    applicationId: legacy.applicationId,
    workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
    groupId: legacy.groupId,
    principalId: legacy.principalId,
    role: legacy.role,
    status,
    joined,
    updated: normalizePersistedGroupAudit(legacy.updated, 'Stored member updated'),
    left: normalizeOptionalPersistedGroupAudit(legacy, 'left', 'Stored member left'),
    removed: normalizeOptionalPersistedGroupAudit(legacy, 'removed', 'Stored member removed'),
    banned: normalizeOptionalPersistedGroupAudit(legacy, 'banned', 'Stored member banned'),
    invitedByPrincipalId: persistedOrDefault(legacy, 'invitedByPrincipalId', null),
    invitationExpiresAtEpochMs: persistedOrDefault(legacy, 'invitationExpiresAtEpochMs', null),
  };
  validatePersistedGroupMember(canonical, ref);
  return canonical;
}

export function normalizePersistedGroupPresenceSession(value: unknown, ref: GroupRef): GroupPresenceSession {
  const legacy = requireRecord(value, 'Stored group presence session');
  assertExactKeys(
    legacy,
    [
      'applicationId',
      'workspaceId',
      'groupId',
      'sessionId',
      'principalId',
      'generationId',
      'generationVersion',
      'status',
      'connectedAtEpochMs',
      'lastHeartbeatAtEpochMs',
      'expiresAtEpochMs',
      'disconnectedAtEpochMs',
      'disconnectReason',
    ],
    'Stored group presence session',
  );
  const disconnectedAtEpochMs = persistedOrDefault(legacy, 'disconnectedAtEpochMs', null);
  const disconnectReason = persistedOrDefault(legacy, 'disconnectReason', null);
  const canonical: unknown = {
    applicationId: legacy.applicationId,
    workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
    groupId: legacy.groupId,
    sessionId: legacy.sessionId,
    principalId: legacy.principalId,
    generationId: legacy.generationId,
    generationVersion: legacy.generationVersion,
    status: Object.hasOwn(legacy, 'status') ? legacy.status : disconnectedAtEpochMs === null ? 'active' : 'disconnected',
    connectedAtEpochMs: legacy.connectedAtEpochMs,
    lastHeartbeatAtEpochMs: legacy.lastHeartbeatAtEpochMs,
    expiresAtEpochMs: legacy.expiresAtEpochMs,
    disconnectedAtEpochMs,
    disconnectReason,
  };
  validatePersistedGroupPresenceSession(canonical, ref);
  return canonical;
}

export function normalizePersistedGroupPresenceSummary(value: unknown, ref: GroupRef): GroupPresenceSummary {
  const legacy = requireRecord(value, 'Stored presence summary value');
  assertExactKeys(
    legacy,
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
  if (!Array.isArray(legacy.activeSessions)) {
    throw new TypeError('Stored presence summary activeSessions is invalid');
  }
  const activeSessions = legacy.activeSessions.map((session) => normalizePersistedGroupPresenceSession(session, ref));
  const canonical: unknown = {
    ...legacy,
    workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
    activeSessions,
  };
  validatePersistedGroupPresenceSummary(canonical, ref);
  return canonical;
}

export function normalizePersistedGroupPresenceAdmission(value: unknown, ref: GroupRef): GroupPresenceAdmission {
  const legacy = requireRecord(value, 'Presence admission');
  assertExactKeys(legacy, ['applicationId', 'workspaceId', 'groupId', 'principalId', 'admittedSessions', 'updatedAtEpochMs'], 'Presence admission');
  const canonical: unknown = {
    ...legacy,
    workspaceId: persistedOrDefault(legacy, 'workspaceId', ref.workspaceId),
  };
  validatePersistedGroupPresenceAdmission(canonical, ref);
  return canonical;
}

function persistedOrDefault(value: Readonly<Record<string, unknown>>, key: string, fallback: unknown): unknown {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

function normalizeOptionalPersistedGroupAudit(value: Readonly<Record<string, unknown>>, key: string, label: string): AuditStamp | null {
  return Object.hasOwn(value, key) ? normalizeNullablePersistedGroupAudit(value[key], label) : null;
}

function normalizeNullablePersistedGroupAudit(value: unknown, label: string): AuditStamp | null {
  return value === null ? null : normalizePersistedGroupAudit(value, label);
}

function normalizePersistedGroupAudit(value: unknown, label: string): AuditStamp {
  const legacy = requireRecord(value, label);
  assertExactKeys(legacy, ['atEpochMs', 'actor', 'byPrincipalId', 'bySessionId', 'byServiceId', 'reason', 'traceId', 'requestId'], label);
  const canonical: unknown = {
    atEpochMs: legacy.atEpochMs,
    actor: Object.hasOwn(legacy, 'actor') ? legacy.actor : normalizePersistedGroupActor(legacy, `${label} actor`),
    reason: persistedOrDefault(legacy, 'reason', null),
    traceId: persistedOrDefault(legacy, 'traceId', null),
    requestId: persistedOrDefault(legacy, 'requestId', null),
  };
  validateAuditStamp(canonical, label);
  return canonical;
}

function normalizePersistedGroupActor(legacy: Readonly<Record<string, unknown>>, label: string): MutationActor {
  let canonical: unknown;
  if (Object.hasOwn(legacy, 'bySessionId')) {
    canonical = {
      kind: 'session',
      sessionId: legacy.bySessionId,
      principalId: legacy.byPrincipalId,
    };
  } else if (Object.hasOwn(legacy, 'byPrincipalId')) {
    canonical = { kind: 'principal', principalId: legacy.byPrincipalId };
  } else {
    canonical = { kind: 'service', serviceId: legacy.byServiceId };
  }
  validateMutationActor(canonical, label);
  return canonical;
}
