import type { AuditStamp } from '@shared/api/group-types.ts';
import type { GroupMutationRead } from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  groupMemberStorageKey,
  groupRef,
  groupStorageKey,
  storedEntry,
} from './group-state/mutation/group-mutation-test-runtime.ts';

export function createCorruptionMutationRead(): GroupMutationRead {
  const audit = persistenceAuditStamp(1_000, 'alice', 'seed');
  const group = {
    ...groupRef('pure-room'),
    ...{ slug: null, displayName: 'Before', description: null },
    ...{ kind: 'room' as const, status: 'active' as const, joinMode: 'open' as const },
    ...{ archived: null, deleted: null, expiresAtEpochMs: null },
    ...{ maxMembers: null, maxSessionsPerMember: null, metadata: {} },
    ...{ activeMemberCount: 1, ownerPrincipalId: 'alice' },
    ...{ snapshotVersion: 1, metadataVersion: 1, rosterVersion: 1, presenceVersion: 0 },
    ...{ emptySinceEpochMs: null, purgeAfterEpochMs: null, created: audit, updated: audit },
  };
  const actorMember = {
    ...groupRef('pure-room'),
    ...{ principalId: 'alice', role: 'owner' as const, status: 'active' as const },
    ...{ invitedByPrincipalId: null, invitationExpiresAtEpochMs: null },
    ...{ left: null, removed: null, banned: null, joined: audit, updated: audit },
  };
  return {
    ...{ idempotency: null, group: storedEntry(groupStorageKey(), group) },
    ...{ expiredGroupEntry: null, actorMember, targetMember: null },
    ...{ authorityMember: null, directorMember: null },
    actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
    ...{ targetMemberEntry: null, authorityMemberEntry: null, directorMemberEntry: null },
    ...{ targetPresence: null, expiredTargetPresenceEntry: null, targetAdmission: null },
    ...{ authorityAdmission: null, directorAdmission: null },
    ...{ authorityPresenceSessions: [], authorityPresenceSessionEntries: [] },
    presenceSummary: null,
  } as GroupMutationRead;
}

export function createIdentityMutationRead(): GroupMutationRead {
  const audit = persistenceAuditStamp(1_000, 'alice', 'seed');
  const group = {
    ...groupRef('pure-room'),
    ...{ slug: null, displayName: 'Before', description: null },
    ...{ kind: 'room' as const, status: 'active' as const, joinMode: 'open' as const },
    ...{ archived: null, deleted: null, expiresAtEpochMs: null },
    ...{ maxMembers: null, maxSessionsPerMember: null, metadata: {} },
    ...{ activeMemberCount: 1, ownerPrincipalId: 'alice' },
    ...{ snapshotVersion: 1, metadataVersion: 1, rosterVersion: 1, presenceVersion: 0 },
    ...{ emptySinceEpochMs: null, purgeAfterEpochMs: null, created: audit, updated: audit },
  };
  const actorMember = {
    ...groupRef('pure-room'),
    ...{ principalId: 'alice', role: 'owner' as const, status: 'active' as const },
    ...{ invitedByPrincipalId: null, invitationExpiresAtEpochMs: null },
    ...{ left: null, removed: null, banned: null, joined: audit, updated: audit },
  };
  return {
    ...{ idempotency: null, group: storedEntry(groupStorageKey(), group) },
    ...{ expiredGroupEntry: null, actorMember, targetMember: null },
    ...{ authorityMember: null, directorMember: null },
    actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
    ...{ targetMemberEntry: null, authorityMemberEntry: null, directorMemberEntry: null },
    ...{ targetPresence: null, expiredTargetPresenceEntry: null, targetAdmission: null },
    ...{ authorityAdmission: null, directorAdmission: null },
    ...{ authorityPresenceSessions: [], authorityPresenceSessionEntries: [] },
    presenceSummary: null,
  } as GroupMutationRead;
}

export function createSnapshotAssemblyMutationRead(): GroupMutationRead {
  const audit = persistenceAuditStamp(1_000, 'alice', 'seed');
  const group = {
    ...groupRef('pure-room'),
    ...{ slug: null, displayName: 'Before', description: null },
    ...{ kind: 'room' as const, status: 'active' as const, joinMode: 'open' as const },
    ...{ archived: null, deleted: null, expiresAtEpochMs: null },
    ...{ maxMembers: null, maxSessionsPerMember: null, metadata: {} },
    ...{ activeMemberCount: 1, ownerPrincipalId: 'alice' },
    ...{ snapshotVersion: 1, metadataVersion: 1, rosterVersion: 1, presenceVersion: 0 },
    ...{ emptySinceEpochMs: null, purgeAfterEpochMs: null, created: audit, updated: audit },
  };
  const actorMember = {
    ...groupRef('pure-room'),
    ...{ principalId: 'alice', role: 'owner' as const, status: 'active' as const },
    ...{ invitedByPrincipalId: null, invitationExpiresAtEpochMs: null },
    ...{ left: null, removed: null, banned: null, joined: audit, updated: audit },
  };
  return {
    ...{ idempotency: null, group: storedEntry(groupStorageKey(), group) },
    ...{ expiredGroupEntry: null, actorMember, targetMember: null },
    ...{ authorityMember: null, directorMember: null },
    actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
    ...{ targetMemberEntry: null, authorityMemberEntry: null, directorMemberEntry: null },
    ...{ targetPresence: null, expiredTargetPresenceEntry: null, targetAdmission: null },
    ...{ authorityAdmission: null, directorAdmission: null },
    ...{ authorityPresenceSessions: [], authorityPresenceSessionEntries: [] },
    presenceSummary: null,
  } as GroupMutationRead;
}

function persistenceAuditStamp(
  atEpochMs: number,
  principalId: string,
  requestId: string | null,
): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'principal', principalId },
    reason: null,
    traceId: null,
    requestId,
  };
}
