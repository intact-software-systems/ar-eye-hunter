import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type {
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
} from './group-mutation-contracts.ts';
import { mutationTargetPrincipalId, mutationTargetSessionId } from './validate-group-mutation-read.ts';
import {
  requireGroup,
  validateCommandHash,
  validateGroupMutationIdempotencyRecord,
  validateMutationReceipt,
} from './group-mutation-result.ts';
import { findKnownMember } from './compute-group-membership-mutation.ts';
import { validateStoredGroup, validateStoredMember } from '../persistence/validate-persisted-group.ts';
import {
  validatePresenceAdmission,
  validatePresenceSession,
  validatePresenceSummaryValue,
} from '../persistence/validate-persisted-group-presence.ts';
import { validateInitialGroupPresenceSummaryCandidate } from '../../services/group-initial-presence-summary.ts';
import {
  assertExactKeys,
  assertRequiredKeys,
  requireNonEmptyString,
  requireNonNegativeSafeInteger,
  requireOneOf,
} from './group-state-validation-primitives.ts';
import { validateGroupEvent } from '../../persisted-group-event.ts';
export function validateComputedMutationShape(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  computed: GroupMutationComputed,
): void {
  const value = computed as unknown as Record<string, unknown>;
  switch (computed.outcome) {
    case 'replay':
    case 'no-op':
    case 'rejected':
      assertExactKeys(value, ['outcome', 'receipt'], 'Group mutation computed result');
      assertRequiredKeys(value, ['outcome', 'receipt'], 'Group mutation computed result');
      validateMutationReceipt(computed.receipt, command.aggregateRef, 'Group mutation computed receipt');
      if (computed.receipt.commandHash !== facts.commandHash) {
        throw new TypeError('Group mutation computed receipt hash differs from facts');
      }
      if (computed.outcome !== 'replay' && computed.receipt.outcome !== computed.outcome) {
        throw new TypeError('Group mutation computed receipt outcome differs');
      }
      return;
    case 'idempotency-conflict':
      assertExactKeys(
        value,
        ['outcome', 'existingCommandHash', 'receivedCommandHash'],
        'Group mutation computed result',
      );
      assertRequiredKeys(
        value,
        ['outcome', 'existingCommandHash', 'receivedCommandHash'],
        'Group mutation computed result',
      );
      validateCommandHash(computed.existingCommandHash, 'Group mutation existingCommandHash');
      validateCommandHash(computed.receivedCommandHash, 'Group mutation receivedCommandHash');
      if (computed.receivedCommandHash !== facts.commandHash) {
        throw new TypeError('Group mutation conflict hash differs from facts');
      }
      return;
    case 'write':
      assertExactKeys(
        value,
        [
          'outcome',
          'guard',
          'members',
          'initialPresenceSummary',
          'presenceAdmission',
          'event',
          'receipt',
          'idempotency',
          'outboxEntries',
        ],
        'Group mutation computed result',
      );
      assertRequiredKeys(
        value,
        [
          'outcome',
          'guard',
          'members',
          'initialPresenceSummary',
          'presenceAdmission',
          'event',
          'receipt',
          'idempotency',
          'outboxEntries',
        ],
        'Group mutation computed result',
      );
      validateComputedWrite(command, read, facts, computed);
      return;
  }
}

function validateComputedWrite(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
  const ref = command.aggregateRef;
  const guard = computed.guard as unknown as Record<string, unknown>;
  assertExactKeys(
    guard,
    ['kind', 'operation', 'value', ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision'])],
    'Group mutation computed guard',
  );
  assertRequiredKeys(
    guard,
    ['kind', 'operation', 'value', ...(computed.guard.operation === 'insert' ? [] : ['expectedRevision'])],
    'Group mutation computed guard',
  );
  requireOneOf(computed.guard.kind, ['group', 'presence'], 'Group mutation computed guard kind');
  requireOneOf(computed.guard.operation, ['insert', 'update', 'delete'], 'Group mutation computed guard operation');
  if (computed.guard.operation !== 'insert') {
    requireNonNegativeSafeInteger(computed.guard.expectedRevision, 'Group mutation computed guard expectedRevision');
  }
  if (computed.guard.kind === 'group') {
    if (guard.operation === 'delete') {
      throw new TypeError('Group mutation cannot use a group delete guard');
    }
    validateStoredGroup(computed.guard.value, ref);
    const expectedRevision = read.group?.entry.revision ?? read.expiredGroupEntry?.revision;
    if (computed.guard.operation === 'insert') {
      if (expectedRevision !== undefined) {
        throw new TypeError('Group insert guard has an existing predecessor');
      }
    } else if (computed.guard.expectedRevision !== expectedRevision) {
      throw new TypeError('Group update guard revision differs from predecessor');
    }
  } else {
    validatePresenceSession(computed.guard.value, ref, 'Group mutation computed presence guard');
    const expectedSessionId = mutationTargetSessionId(command);
    const expectedPrincipalId = mutationTargetPrincipalId(command);
    if (
      expectedSessionId === null ||
      expectedPrincipalId === null ||
      computed.guard.value.sessionId !== expectedSessionId ||
      computed.guard.value.principalId !== expectedPrincipalId
    ) {
      throw new TypeError('Group mutation presence guard differs from command target identity');
    }
    const expectedRevision = read.targetPresence?.entry.revision ?? read.expiredTargetPresenceEntry?.revision;
    if (computed.guard.operation === 'insert') {
      if (expectedRevision !== undefined) {
        throw new TypeError('Presence insert guard has an existing predecessor');
      }
    } else if (computed.guard.expectedRevision !== expectedRevision) {
      throw new TypeError('Presence write guard revision differs from predecessor');
    }
    if (
      computed.guard.operation === 'delete' &&
      (command.operation !== 'disconnectPresence' ||
        facts.internalAuthority !== 'expiry' ||
        command.input.reason !== 'expired')
    ) {
      throw new TypeError('Presence delete guard requires expiry authority');
    }
  }
  if (!Array.isArray(computed.members)) {
    throw new TypeError('Group mutation computed members must be an array');
  }
  for (const member of computed.members) {
    validateStoredMember(member, ref, 'Group mutation computed member');
  }
  const expectedMemberPrincipalIds = expectedMutationMemberPrincipalIds(command, read);
  const actualMemberPrincipalIds = computed.members.map((member) => member.principalId).toSorted();
  if (!jsonEquals(actualMemberPrincipalIds, expectedMemberPrincipalIds)) {
    throw new TypeError('Group mutation member candidate identity differs from command target');
  }
  if (computed.initialPresenceSummary !== null) {
    if (command.operation !== 'createGroup')
      throw new TypeError('Initial group presence summary operation requires group creation');
    validateInitialGroupPresenceSummaryCandidate(computed.initialPresenceSummary, read.presenceSummary);
    validatePresenceSummaryValue(computed.initialPresenceSummary.value, ref);
  }
  if (computed.presenceAdmission !== null) {
    const admission = computed.presenceAdmission as unknown as Record<string, unknown>;
    assertExactKeys(
      admission,
      ['operation', 'value', ...(computed.presenceAdmission.operation === 'update' ? ['expectedRevision'] : [])],
      'Group mutation computed admission',
    );
    assertRequiredKeys(
      admission,
      ['operation', 'value', ...(computed.presenceAdmission.operation === 'update' ? ['expectedRevision'] : [])],
      'Group mutation computed admission',
    );
    requireOneOf(
      computed.presenceAdmission.operation,
      ['insert', 'update'],
      'Group mutation computed admission operation',
    );
    validatePresenceAdmission(computed.presenceAdmission.value, ref);
    if (computed.presenceAdmission.operation === 'update') {
      requireNonNegativeSafeInteger(
        computed.presenceAdmission.expectedRevision,
        'Group mutation computed admission expectedRevision',
      );
    }
    const predecessor = read.targetAdmission;
    if (computed.presenceAdmission.operation === 'insert') {
      if (predecessor !== null) {
        throw new TypeError('Group mutation admission insert has an existing predecessor');
      }
    } else if (predecessor === null || computed.presenceAdmission.expectedRevision !== predecessor.entry.revision) {
      throw new TypeError('Group mutation admission update revision differs from predecessor');
    }
    const admittedPrincipalId = computed.presenceAdmission.value.principalId;
    const expectedPrincipalId = mutationTargetPrincipalId(command);
    if (expectedPrincipalId === null || expectedPrincipalId !== admittedPrincipalId) {
      throw new TypeError('Group mutation admission principal differs from command target identity');
    }
  }
  validateGroupEvent(computed.event, ref, 'Group mutation computed event');
  if (
    computed.event.eventId !== facts.eventId ||
    computed.event.occurredAtEpochMs !== facts.nowEpochMs ||
    (computed.event.requestId ?? null) !== command.requestId ||
    actorPrincipalId(computed.event.actor) !== command.input.actorPrincipalId ||
    actorSessionId(computed.event.actor) !== command.input.actorSessionId
  ) {
    throw new TypeError('Group mutation computed event identity differs from command and facts');
  }
  validateMutationReceipt(computed.receipt, ref, 'Group mutation computed receipt');
  if (
    computed.receipt.outcome !== 'applied' ||
    computed.receipt.commandId !== command.commandId ||
    computed.receipt.commandHash !== facts.commandHash
  ) {
    throw new TypeError('Group mutation computed receipt differs from command');
  }
  if (computed.idempotency !== null) {
    validateGroupMutationIdempotencyRecord(computed.idempotency, ref);
    if (
      computed.idempotency.requestId !== command.requestId ||
      !jsonEquals(computed.idempotency.receipt, computed.receipt)
    ) {
      throw new TypeError('Group mutation computed idempotency differs from receipt');
    }
  } else if (command.requestId !== null) {
    throw new TypeError('Group mutation computed idempotency is missing');
  }
  validateComputedOutboxEntries(command, facts, computed);
}

function expectedMutationMemberPrincipalIds(command: GroupMutationCommand, read: GroupMutationRead): readonly string[] {
  switch (command.operation) {
    case 'createGroup':
      return [command.input.createdByPrincipalId];
    case 'joinGroup':
    case 'acceptGroupInvite':
    case 'createGroupInvite':
    case 'revokeGroupInvite':
    case 'removeGroupMember':
    case 'banGroupMember':
    case 'unbanGroupMember':
    case 'setGroupMemberRole':
    case 'upsertMember':
      return [command.targetPrincipalId];
    case 'transferGroupOwnership': {
      const currentOwner = read.group?.value.ownerPrincipalId;
      return currentOwner === undefined
        ? [command.targetPrincipalId]
        : [currentOwner, command.targetPrincipalId].toSorted();
    }
    case 'updateGroup':
    case 'appointDirector':
    case 'rotateGroupJoinCode':
    case 'connectPresence':
    case 'heartbeatPresence':
    case 'disconnectPresence':
      return [];
  }
}

export function validateComputedOutboxEntries(
  command: GroupMutationCommand,
  facts: GroupMutationFacts,
  computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
  if (!Array.isArray(computed.outboxEntries) || computed.outboxEntries.length !== 1) {
    throw new TypeError('Group mutation must compute one presence-summary outbox entry');
  }
  const expected = computeGroupPresenceSummaryEntry(
    {
      effectKind: 'group-presence-summary',
      aggregateRef: command.aggregateRef,
      commandId: command.commandId,
      createdAtEpochMs: facts.nowEpochMs,
      expireAtEpochMs: facts.expireAtEpochMs,
      acceptedCausalRevision: computed.receipt.causalRevision,
      event: computed.event,
    },
    facts.serviceId,
  );
  if (!jsonEquals(computed.outboxEntries[0], expected)) {
    throw new TypeError('Group mutation presence-summary outbox entry is not canonical');
  }
}

export function validateComputedRosterFacts(
  read: GroupMutationRead,
  computed: Extract<GroupMutationComputed, { outcome: 'write' }>,
): void {
  if (computed.guard.kind !== 'group') return;
  const candidate = computed.guard.value;
  if (!Number.isSafeInteger(candidate.activeMemberCount) || candidate.activeMemberCount < 1) {
    throw new TypeError('Group activeMemberCount must be a positive safe integer');
  }
  requireNonEmptyString(candidate.ownerPrincipalId, 'Group ownerPrincipalId');
  if (
    computed.guard.operation === 'insert' ||
    (read.group === null &&
      computed.guard.operation === 'update' &&
      computed.guard.expectedRevision === read.expiredGroupEntry?.revision)
  ) {
    const active = computed.members.filter((member) => member.status === 'active');
    const owners = active.filter((member) => member.role === 'owner');
    if (
      candidate.activeMemberCount !== active.length ||
      owners.length !== 1 ||
      owners[0]?.principalId !== candidate.ownerPrincipalId
    ) {
      throw new TypeError('Inserted group roster facts differ from member candidates');
    }
    return;
  }
  const current = requireGroup(read, candidate);
  let expectedCount = current.value.activeMemberCount;
  for (const member of computed.members) {
    const previous = findKnownMember(read, member.principalId);
    if ((previous?.status === 'active') !== (member.status === 'active')) {
      expectedCount += member.status === 'active' ? 1 : -1;
    }
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || candidate.activeMemberCount !== expectedCount) {
    throw new TypeError('Updated group activeMemberCount has an invalid predecessor delta');
  }
  const promoted = computed.members.filter(
    (member) =>
      member.status === 'active' && member.role === 'owner' && member.principalId !== current.value.ownerPrincipalId,
  );
  const currentOwnerCandidate = computed.members.find(
    (member) => member.principalId === current.value.ownerPrincipalId,
  );
  const expectedOwner =
    promoted.length === 1 &&
    currentOwnerCandidate &&
    (currentOwnerCandidate.status !== 'active' || currentOwnerCandidate.role !== 'owner')
      ? promoted[0]!.principalId
      : current.value.ownerPrincipalId;
  if (promoted.length > 1 || candidate.ownerPrincipalId !== expectedOwner) {
    throw new TypeError('Updated group ownerPrincipalId has an invalid predecessor delta');
  }
}

function actorPrincipalId(actor: MutationActor): string | null {
  return actor.kind === 'service' ? null : actor.principalId;
}

function actorSessionId(actor: MutationActor): string | null {
  return actor.kind === 'session' ? actor.sessionId : null;
}

export { validateComputedMutationShape as validateComputedGroupMutation };
