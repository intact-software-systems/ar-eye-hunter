import { describe, expect, it } from 'vitest';
import type { AuditStamp } from '@shared/api/group-types.ts';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import {
  computeGroupMutation,
  validateGroupMutation,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  groupMemberStorageKey,
  groupRef,
  groupStorageKey,
  storedEntry,
} from './group-mutation-test-runtime.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

describe('group aggregate mutation computation', () => {
  it('keeps pure mutation computation synchronous, deterministic, and input preserving', () => {
    const command = deepFreeze(createMutationCommand());
    const read = deepFreeze(createMutationRead());
    const facts = deepFreeze(createMutationFacts());

    const first = computeGroupMutation({ command, read, facts });
    const second = computeGroupMutation({ command, read, facts });
    validateGroupMutation({ command, read, facts, computed: first });
    validateGroupMutation({ command, read, facts, computed: second });

    expect(first).toEqual(second);
    expect(command).toEqual(createMutationCommand());
    expect(read).toEqual(createMutationRead());
  });

  it('binds resolved join-code facts to the command operation and explicit intent', () => {
    const read = createMutationRead();
    const update = createMutationCommand();
    const explicitRotate = createMutationCommand({
      operation: 'rotateGroupJoinCode',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        joinCode: 'EXPLICIT',
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const omittedRotate = createMutationCommand({
      operation: 'rotateGroupJoinCode',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        joinCode: null,
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const codeFacts: GroupMutationFacts = {
      ...createMutationFacts(),
      resolvedJoinCode: 'OTHER',
      joinCodeVerifier: 'verifier',
    };

    expect(() => computeGroupMutation({ command: update, read, facts: codeFacts })).toThrow(
      /resolved.*join code|operation|unrelated/i,
    );
    expect(() =>
      computeGroupMutation({
        command: explicitRotate,
        read,
        facts: codeFacts,
      }),
    ).toThrow(/resolved.*join code|explicit|command/i);
    expect(() =>
      computeGroupMutation({
        command: omittedRotate,
        read,
        facts: createMutationFacts(),
      }),
    ).toThrow(/resolved.*join code|generated|missing/i);
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
  const group = createTestGroup({
    ...groupRef('pure-room'),
    displayName: 'Before',
    activeMemberCount: 1,
    ownerPrincipalId: 'alice',
    snapshotVersion: 1,
    metadataVersion: 1,
    rosterVersion: 1,
    presenceVersion: 0,
    created: audit,
    updated: audit,
  });
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
    lifecyclePolicy: null,
    activeMemberPrincipalIds: null,
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
    formationDamping: 'legacy',
    authenticatedAuthority: {
      principalId: 'alice',
      sessionId: 'alice-session',
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
