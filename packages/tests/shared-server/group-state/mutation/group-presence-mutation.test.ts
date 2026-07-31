import { describe, expect, it } from 'vitest';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/services/group-state-mutations.ts';

import {
  createMutationCommand,
  createMutationFacts,
  createMutationRead,
  groupSessionStorageKey,
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
