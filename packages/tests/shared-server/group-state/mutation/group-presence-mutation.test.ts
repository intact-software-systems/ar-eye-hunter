import { describe, expect, it } from 'vitest';
import type { AuditStamp } from '@shared/api/group-types.ts';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  groupMemberStorageKey,
  groupRef,
  groupSessionStorageKey,
  groupStorageKey,
  presenceFor,
  storedEntry,
} from './group-mutation-test-runtime.ts';

describe('group presence mutation computation', () => {
  it('rejects a canonical target session whose value belongs to another principal', () => {
    const wrongPrincipalSession = presenceFor('bob', 'alice-session', 'generation-1');
    const read: GroupMutationRead = {
      ...createMutationRead(),
      targetPresence: storedEntry(groupSessionStorageKey('alice-session'), wrongPrincipalSession),
    };
    const internalRead: GroupMutationRead = {
      ...read,
      actorMember: null,
      actorMemberEntry: null,
      targetMember: read.actorMember,
      targetMemberEntry: read.actorMemberEntry,
    };
    const disconnect = createMutationCommand({
      operation: 'disconnectPresence',
      sessionId: 'alice-session',
      commandId: 'cleanup-command',
      requestId: 'cleanup-command',
      input: {
        actorPrincipalId: null,
        actorSessionId: null,
        reason: null,
        traceId: null,
        principalId: 'alice',
        generationId: 'generation-1',
        generationVersion: 1_000,
        observedExpiresAtEpochMs: 10_000,
        disconnectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs: null,
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const facts: GroupMutationFacts = {
      ...createMutationFacts(),
      internalAuthority: 'session-cleanup',
      authenticatedAuthority: null,
    };
    const appointment = createMutationCommand({
      operation: 'appointDirector',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        heartbeatTtlMs: 5_000,
      },
    } as Partial<GroupMutationCommand>);

    expect(() =>
      computeGroupMutation({
        command: disconnect,
        read: internalRead,
        facts,
      }),
    ).toThrow(/target presence principal.*command|command slot identity/i);
    expect(() =>
      computeGroupMutation({
        command: appointment,
        read,
        facts: createMutationFacts(),
      }),
    ).toThrow(/target presence principal.*command|command slot identity/i);
  });
});

function createMutationCommand(
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

function auditStamp(atEpochMs: number, principalId: string, requestId: string | null): AuditStamp {
  return {
    atEpochMs,
    actor: { kind: 'principal', principalId },
    reason: null,
    traceId: null,
    requestId,
  };
}

function createMutationRead(): GroupMutationRead {
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

function createMutationFacts(): GroupMutationFacts {
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
