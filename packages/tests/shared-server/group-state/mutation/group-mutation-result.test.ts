import { describe, expect, it } from 'vitest';
import type {
  AuditStamp,
  GroupPresenceAdmission,
  GroupPresenceSummary,
} from '@shared/api/group-types.ts';
import type {
  GroupMutationCommand,
  GroupMutationFacts,
  GroupMutationRead,
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { validateGroupMutationIdempotencyRecord } from '@shared-server/rallar-system/group-state/mutation/result-validation/validate-group-mutation-result.ts';
import { validateGroupMutation } from '@shared-server/rallar-system/group-state/mutation/state-validation/validate-group-mutation.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import { FakeRuntimeStateRepository } from '../../fake-runtime-state-repository.ts';
import { createTestGroupStateService } from '../group-state-test-runtime.ts';

import {
  SCOPE,
  groupMemberStorageKey,
  groupRef as runtimeGroupRef,
  groupStorageKey,
  storedEntry,
} from './group-mutation-test-runtime.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

class GroupBarrierRepository extends FakeRuntimeStateRepository {}

function createService(runtimeRepository: GroupBarrierRepository, nowEpochMs: number) {
  let id = 0;
  return createTestGroupStateService({
    runtimeRepository,
    now: () => nowEpochMs,
    randomId: () => `id-${nowEpochMs}-${++id}`,
    serviceId: 'group-service',
  });
}

async function seedOpenGroup(
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

const groupRef = {
  applicationId: 'app-1',
  workspaceId: 'workspace-1',
  groupId: 'group-1',
};

function idempotencyRecord() {
  const commandHash = `sha256:${'a'.repeat(64)}`;
  return {
    aggregateRef: groupRef,
    requestId: 'request-1',
    commandHash,
    receipt: {
      commandId: 'request-1',
      requestId: 'request-1',
      commandHash,
      aggregateRef: groupRef,
      outcome: 'no-op',
      attemptCount: 1,
      acceptedStorageRevision: 0,
      stateRevision: 1,
      snapshotVersion: 1,
      causalRevision: { groupRevision: 1, presenceRevision: 0 },
      eventId: null,
      outboxIds: [],
      joinCode: null,
      joinCodeExpiresAtEpochMs: null,
      rejection: null,
    },
  };
}

describe('group mutation receipt causal invariants', () => {
  it('requires receipt snapshotVersion to equal causal groupRevision', () => {
    const valid = idempotencyRecord();
    expect(() => validateGroupMutationIdempotencyRecord(valid, groupRef)).not.toThrow();

    expect(() =>
      validateGroupMutationIdempotencyRecord(
        {
          ...valid,
          receipt: { ...valid.receipt, snapshotVersion: 2 },
        },
        groupRef,
      ),
    ).toThrow(/snapshotVersion.*causalRevision/u);
  });
});

{
  const groupRef = runtimeGroupRef;

  describe('group mutation rejected-result persistence', () => {
    it('does not persist a rejected receipt, event, or outbox effect', async () => {
      const runtime = new GroupBarrierRepository();
      await seedOpenGroup(runtime, 'ephemeral-rejection-room');
      const result = await createService(runtime, 2_000).createGroup(SCOPE, {
        groupId: 'ephemeral-rejection-room',
        displayName: 'Duplicate',
        kind: 'room',
        createdByPrincipalId: 'alice',
        actorPrincipalId: 'alice',
        requestId: 'rejected-duplicate-create',
      });
      expect(result).toMatchObject({ status: 'error' });
      const repository = new GroupStateRepository(runtime);
      expect(
        await repository.findIdempotentGroupMutationReceipt(
          groupRef('ephemeral-rejection-room'),
          'rejected-duplicate-create',
        ),
      ).toBeUndefined();
      expect(
        (await repository.listEvents(groupRef('ephemeral-rejection-room'))).filter(
          (event) => event.requestId === 'rejected-duplicate-create',
        ),
      ).toEqual([]);
    });
  });

  describe('computed group mutation validation', () => {
    it('rejects malformed computed guards, receipts, and outbox projections', () => {
      const command = createMutationCommand();
      const read = createMutationRead();
      const facts = createMutationFacts();
      const computed = computeGroupMutation({ command, read, facts });
      if (computed.outcome !== 'write') throw new Error('Expected write computation');
      const cases = [
        {
          ...computed,
          guard: {
            ...computed.guard,
            value: { ...computed.guard.value, groupId: 'wrong-room' },
          },
        },
        {
          ...computed,
          receipt: { ...computed.receipt, stateRevision: -1 },
        },
        {
          ...computed,
          outboxEntries: [],
        },
        {
          ...computed,
          outboxEntries: [
            {
              ...computed.outboxEntries[0],
              key: {
                ...computed.outboxEntries[0].key,
                resourceId: 'non-canonical-summary-entry',
              },
            },
          ],
        },
      ] as const;

      for (const malformed of cases) {
        expect(() =>
          validateGroupMutation({
            command,
            read,
            facts,
            computed: malformed as never,
          }),
        ).toThrow(/scope|revision|snapshot|effect|outbox|receipt/i);
      }
    });

    it('rejects every non-canonical operation projection before write', () => {
      const command = createMutationCommand();
      const read = createMutationRead();
      const facts = createMutationFacts();
      const computed = computeGroupMutation({ command, read, facts });
      if (computed.outcome !== 'write' || computed.guard.kind !== 'group') {
        throw new Error('Expected group write computation');
      }
      const sessionEvent = {
        ...computed.event,
        eventType: 'session-connected' as const,
      };
      const consistentlyWrongEvent = {
        ...computed,
        event: sessionEvent,
        receipt: {
          ...computed.receipt,
          event: { kind: 'group' as const, event: sessionEvent },
        },
        idempotency: computed.idempotency && {
          ...computed.idempotency,
          receipt: {
            ...computed.receipt,
            event: { kind: 'group' as const, event: sessionEvent },
          },
        },
        outbox: {
          ...computed.outbox,
          event: { kind: 'group' as const, event: sessionEvent },
        },
      };
      const injectedSummary: GroupPresenceSummary = {
        ...groupRef('pure-room'),
        causalRevision: { groupRevision: 2, presenceRevision: 0 },
        activePrincipalIds: [],
        activeSessionIds: [],
        activeSessions: [],
        activePrincipalCount: 0,
        activeSessionCount: 0,
        computedAtEpochMs: facts.nowEpochMs,
      };
      const wrongDependent = {
        ...computed,
        presenceAdmission: {
          operation: 'insert' as const,
          value: admissionFor('alice', []),
        },
      };

      for (const [label, malformed] of [
        ['operation event', consistentlyWrongEvent],
        ['initial summary', { ...computed, initialPresenceSummary: injectedSummary }],
        ['dependent admission', wrongDependent],
      ] as const) {
        expect
          .soft(
            () =>
              validateGroupMutation({
                command,
                read,
                facts,
                computed: malformed as never,
              }),
            label,
          )
          .toThrow(/canonical|deterministic|projection|operation|unexpected key/i);
      }
    });
  });
}

function createMutationCommand(
  overrides: Partial<GroupMutationCommand> = {},
): GroupMutationCommand {
  return {
    operation: 'updateGroup',
    aggregateRef: runtimeGroupRef('pure-room'),
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
    ...runtimeGroupRef('pure-room'),
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
    ...runtimeGroupRef('pure-room'),
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

function admissionFor(
  principalId: string,
  admittedSessions: GroupPresenceAdmission['admittedSessions'],
): GroupPresenceAdmission {
  return {
    ...runtimeGroupRef('pure-room'),
    principalId,
    admittedSessions,
    updatedAtEpochMs: 1_000,
  };
}
