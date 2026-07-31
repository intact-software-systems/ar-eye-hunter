import { describe, expect, it } from 'vitest';
import type { GroupPresenceSession } from '@shared/api/group-types.ts';
import {
  groupStateMemberStorageKey,
  groupStatePresenceAdmissionStorageKey,
  groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
  computeGroupMutation,
  type GroupMutationCommand,
  type GroupMutationFacts,
  type GroupMutationRead,
  validateGroupMutation,
} from '@shared-server/rallar-system/services/group-state-mutations.ts';
import { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import {
  SCOPE,
  groupMemberStorageKey,
  groupRef,
  groupSessionStorageKey,
  groupStorageKey,
  presenceFor,
  storedEntry,
} from '../mutation/group-mutation-test-runtime.ts';
import {
  admissionFor,
  createMutationCommand,
  createMutationFacts,
  createMutationRead,
  groupAdmissionStorageKey,
  memberFor,
} from '../group-state-concurrency-test-fixtures.ts';
import { createService, seedOpenGroup } from '../presence/group-presence-test-runtime.ts';

describe('convergent group and presence state', () => {
  it('binds mutation write candidates to the exact command target', () => {
    const command = createMutationCommand({
      operation: 'setGroupMemberRole',
      targetPrincipalId: 'bob',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        role: 'admin',
      },
    } as Partial<GroupMutationCommand>);
    const bob = memberFor('bob');
    const read: GroupMutationRead = {
      ...createMutationRead(),
      targetMember: bob,
      targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
    };
    const facts = createMutationFacts();
    const computed = computeGroupMutation({ command, read, facts });
    if (computed.outcome !== 'write') throw new Error('Expected write');
    const wrongMember = {
      ...computed.members[0]!,
      principalId: 'charlie',
    };
    const malformed = {
      ...computed,
      members: [wrongMember],
      guard: {
        ...computed.guard,
        value:
          computed.guard.kind === 'group'
            ? { ...computed.guard.value, activeMemberCount: 2 }
            : computed.guard.value,
      },
    };

    expect(() =>
      validateGroupMutation({
        command,
        read,
        facts,
        computed: malformed as never,
      }),
    ).toThrow(/command target|candidate identity|principal/i);
  });

  it('binds heartbeat and disconnect read principals independently from corrupt rows', () => {
    const bob = memberFor('bob');
    const session = presenceFor('bob', 'alice-session', 'generation-1');
    const admission = admissionFor('bob', [
      {
        sessionId: session.sessionId,
        generationId: session.generationId,
        generationVersion: session.generationVersion,
        connectedAtEpochMs: session.connectedAtEpochMs,
      },
    ]);
    const corruptRead: GroupMutationRead = {
      ...createMutationRead(),
      targetMember: bob,
      targetMemberEntry: storedEntry(groupMemberStorageKey('bob'), bob),
      targetPresence: storedEntry(groupSessionStorageKey('alice-session'), session),
      targetAdmission: storedEntry(groupAdmissionStorageKey('bob'), admission),
    };
    const publicFacts = createMutationFacts();
    const heartbeat = createMutationCommand({
      operation: 'heartbeatPresence',
      sessionId: 'alice-session',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        principalId: null,
        generationId: 'generation-1',
        lastHeartbeatAtEpochMs: 2_000,
        expiresAtEpochMs: 10_000,
      },
    } as Partial<GroupMutationCommand>);
    const disconnect = createMutationCommand({
      operation: 'disconnectPresence',
      sessionId: 'alice-session',
      input: {
        actorPrincipalId: 'alice',
        actorSessionId: 'alice-session',
        reason: null,
        traceId: null,
        principalId: null,
        generationId: 'generation-1',
        generationVersion: null,
        observedExpiresAtEpochMs: null,
        disconnectedAtEpochMs: 2_000,
        lastHeartbeatAtEpochMs: null,
        expiresAtEpochMs: null,
      },
    } as Partial<GroupMutationCommand>);
    const internalDisconnect = createMutationCommand({
      ...disconnect,
      commandId: 'cleanup-command',
      requestId: 'cleanup-command',
      input: {
        ...disconnect.input,
        principalId: 'alice',
        actorPrincipalId: null,
        actorSessionId: null,
      },
    } as Partial<GroupMutationCommand>);
    const internalFacts: GroupMutationFacts = {
      ...publicFacts,
      internalAuthority: 'session-cleanup',
      authenticatedAuthority: null,
    };

    for (const [label, command, facts] of [
      ['public heartbeat', heartbeat, publicFacts],
      ['public disconnect', disconnect, publicFacts],
      ['internal disconnect', internalDisconnect, internalFacts],
    ] as const) {
      expect(() => computeGroupMutation({ command, read: corruptRead, facts }), label).toThrow(
        /command slot identity|command principal|canonical principal/i,
      );
    }
  });

  it.each(['heartbeat', 'disconnect'] as const)(
    'reads %s member and admission slots only from the authenticated command principal',
    async (operation) => {
      const runtime = new GroupBarrierRepository();
      const groupId = 'trusted-heartbeat-slot-room';
      const sessionId = 'alice-trusted-slot-session';
      const generationId = 'alice-trusted-slot-generation';
      const service = createService(runtime, 2_000);
      await seedOpenGroup(runtime, groupId);
      await service.connectPresenceSession(SCOPE, groupId, sessionId, {
        principalId: 'alice',
        generationId,
        connectedAtEpochMs: 1_000,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 4_102_444_800_000,
        actorPrincipalId: 'alice',
        actorSessionId: sessionId,
        requestId: 'seed-trusted-slot-session',
      });
      const sessionKey = groupStatePresenceSessionStorageKey({
        ...groupRef(groupId),
        sessionId,
      });
      const storedSession = await runtime.findEntry('group-state:sessions', sessionKey);
      if (!storedSession) throw new Error('Expected stored session');
      await runtime.upsert(
        'group-state:sessions',
        sessionKey,
        JSON.stringify({
          ...(JSON.parse(storedSession.value) as GroupPresenceSession),
          principalId: 'candidate-principal',
        }),
        storedSession.expireAtTimestamp,
      );
      runtime.entryReadKeys = [];

      const mutation =
        operation === 'heartbeat'
          ? service.heartbeatPresenceSession(SCOPE, groupId, sessionId, {
              generationId,
              lastHeartbeatAtEpochMs: 2_000,
              expiresAtEpochMs: 4_102_444_801_000,
              actorPrincipalId: 'alice',
              actorSessionId: sessionId,
              requestId: 'trusted-slot-heartbeat',
            })
          : service.disconnectPresenceSession(SCOPE, groupId, sessionId, {
              generationId,
              disconnectedAtEpochMs: 2_000,
              actorPrincipalId: 'alice',
              actorSessionId: sessionId,
              requestId: 'trusted-slot-disconnect',
            });
      await expect(mutation).rejects.toThrow(
        /presence principal|command principal|canonical principal/i,
      );

      expect(runtime.entryReadKeys).toContain(
        groupStateMemberStorageKey({
          ...groupRef(groupId),
          principalId: 'alice',
        }),
      );
      expect(runtime.entryReadKeys).toContain(
        groupStatePresenceAdmissionStorageKey({
          ...groupRef(groupId),
          principalId: 'alice',
        }),
      );
      expect(runtime.entryReadKeys).not.toContain(
        groupStateMemberStorageKey({
          ...groupRef(groupId),
          principalId: 'candidate-principal',
        }),
      );
      expect(runtime.entryReadKeys).not.toContain(
        groupStatePresenceAdmissionStorageKey({
          ...groupRef(groupId),
          principalId: 'candidate-principal',
        }),
      );
    },
  );

  it('rejects one authority session referenced by different principal admissions', () => {
    const base = createMutationRead();
    const group = {
      ...base.group!.value,
      metadata: {
        rallarDirector: {
          version: 1,
          mode: 'appointed-spa',
          sessionId: 'shared-session',
          principalId: 'director',
          epoch: 1,
          appointedAtEpochMs: 1_000,
          heartbeatTtlMs: 5_000,
        },
      },
    };
    const admitted = {
      sessionId: 'shared-session',
      generationId: 'generation-1',
      generationVersion: 1_000,
      connectedAtEpochMs: 1_000,
    } as const;
    const directorSession = presenceFor('director', 'shared-session', 'generation-1');
    const read: GroupMutationRead = {
      ...base,
      group: storedEntry(groupStorageKey(), group),
      authorityAdmission: storedEntry(
        groupAdmissionStorageKey('alice'),
        admissionFor('alice', [admitted]),
      ),
      directorAdmission: storedEntry(
        groupAdmissionStorageKey('director'),
        admissionFor('director', [admitted]),
      ),
      authorityPresenceSessions: [directorSession],
      authorityPresenceSessionEntries: [
        storedEntry(groupSessionStorageKey('shared-session'), directorSession),
      ],
    };
    const command = createMutationCommand({
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
        command,
        read,
        facts: createMutationFacts(),
      }),
    ).toThrow(/multiple principals|different principal admissions|duplicated authority/i);
  });
});
