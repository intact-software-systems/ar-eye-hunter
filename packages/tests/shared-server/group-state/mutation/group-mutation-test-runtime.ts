import type { AuditStamp, GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../../group-state-test-runtime.ts';

export const SCOPE: StateScope = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
};

export function createMutationCommand(
  overrides: Partial<GroupMutationCommand> = {},
): GroupMutationCommand {
  return {
    operation: 'updateGroup',
    aggregateRef: groupRef('pure-room'),
    commandId: 'pure-command',
    requestId: 'pure-command',
    input: {
      slug: null,
      displayName: 'After',
      description: null,
      kind: null,
      status: null,
      joinMode: null,
      maxMembers: null,
      maxSessionsPerMember: null,
      metadata: null,
      expiresAtEpochMs: null,
      emptySinceEpochMs: null,
      purgeAfterEpochMs: null,
      actorPrincipalId: 'alice',
      actorSessionId: 'alice-session',
      reason: null,
      traceId: null,
    },
    ...overrides,
  } as GroupMutationCommand;
}

export function auditStamp(
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

export function createMutationRead(): GroupMutationRead {
  const audit = auditStamp(1_000, 'alice', 'seed');
  const group = {
    ...groupRef('pure-room'),
    slug: null,
    displayName: 'Before',
    description: null,
    kind: 'room' as const,
    status: 'active' as const,
    archived: null,
    deleted: null,
    joinMode: 'open' as const,
    maxMembers: null,
    maxSessionsPerMember: null,
    metadata: {},
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    expiresAtEpochMs: null,
    emptySinceEpochMs: null,
    purgeAfterEpochMs: null,
    created: audit,
    updated: audit,
  };
  const actorMember = {
    ...groupRef('pure-room'),
    principalId: 'alice',
    role: 'owner' as const,
    status: 'active' as const,
    invitedByPrincipalId: null,
    invitationExpiresAtEpochMs: null,
    left: null,
    removed: null,
    banned: null,
    joined: audit,
    updated: audit,
  };
  return {
    idempotency: null,
    group: storedEntry(groupStorageKey(), group),
    expiredGroupEntry: null,
    actorMember,
    targetMember: null,
    authorityMember: null,
    directorMember: null,
    actorMemberEntry: storedEntry(groupMemberStorageKey('alice'), actorMember),
    targetMemberEntry: null,
    authorityMemberEntry: null,
    directorMemberEntry: null,
    targetPresence: null,
    expiredTargetPresenceEntry: null,
    targetAdmission: null,
    authorityAdmission: null,
    directorAdmission: null,
    authorityPresenceSessions: [],
    authorityPresenceSessionEntries: [],
    presenceSummary: null,
  } as GroupMutationRead;
}

export function storagePart(name: string, value?: string): string {
  return `${name}=${encodeURIComponent(value ?? '_')}`;
}

export function groupStorageKey(): string {
  return [
    storagePart('app', 'app-1'),
    storagePart('ws', 'workspace-1'),
    storagePart('group', 'pure-room'),
  ].join(':');
}

export function groupMemberStorageKey(principalId: string): string {
  return `${groupStorageKey()}:${storagePart('member', principalId)}`;
}

export function storedEntry<T>(key: string, value: T) {
  return {
    entry: {
      key,
      value: JSON.stringify(value),
      expireAtTimestamp: Number.MAX_SAFE_INTEGER,
      updatedTimestamp: new Date(0).toISOString(),
      revision: 0,
    },
    value,
  };
}

export function createMutationFacts(): GroupMutationFacts {
  return {
    nowEpochMs: 2_000,
    expireAtEpochMs: 253_402_300_799_999,
    serviceId: 'group-service',
    eventId: 'event-1',
    commandHash: `sha256:${'a'.repeat(64)}`,
    attemptCount: 1,
    resolvedJoinCode: null,
    joinCodeVerifier: null,
    internalAuthority: 'none',
    authenticatedAuthority: {
      principalId: 'alice',
      sessionId: 'alice-session',
    },
  };
}

export function groupRef(groupId: string): GroupRef {
  return { ...SCOPE, groupId };
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export class GroupBarrierRepository extends FakeRuntimeStateRepository {}

export function createService(runtimeRepository: GroupBarrierRepository, nowEpochMs: number) {
  let id = 0;
  return createTestGroupStateService({
    runtimeRepository,
    now: () => nowEpochMs,
    randomId: () => `id-${nowEpochMs}-${++id}`,
    serviceId: 'group-service',
  });
}

export async function seedOpenGroup(
  runtime: GroupBarrierRepository,
  groupId: string,
  maxMembers = 10,
): Promise<void> {
  await createService(runtime, 1_000).createGroup(SCOPE, {
    groupId,
    displayName: groupId,
    kind: 'room',
    joinMode: 'open',
    maxMembers,
    createdByPrincipalId: 'alice',
    requestId: `seed-${groupId}`,
  });
}

export async function requireSnapshot(runtime: GroupBarrierRepository, groupId: string) {
  const snapshot = await new GroupStateRepository(runtime).readSnapshot(groupRef(groupId));
  if (!snapshot) throw new Error(`Missing group snapshot: ${groupId}`);
  return snapshot;
}
