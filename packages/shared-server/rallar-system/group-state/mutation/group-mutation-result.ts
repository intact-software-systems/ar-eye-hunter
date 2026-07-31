import type { AuditStamp, Group, GroupEvent, GroupEventType, GroupMember, GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';

import type {
  GroupGuardCandidate,
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationIdempotencyRecord,
  GroupMutationRead,
  GroupMutationReceipt,
  PresenceAdmissionCandidate,
  PresenceGuardCandidate,
} from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';
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
  validateGroupRef,
} from '../group-state-validation-primitives.ts';
import { validateCausalRevision, validateScopedValue } from '../persistence/validate-persisted-group.ts';
import { validatePresenceAdmission, validatePresenceSession, validatePresenceSummaryValue } from '../persistence/validate-persisted-group-presence.ts';
import type { InitialGroupPresenceSummaryCandidate } from '../presence/group-initial-presence-summary.ts';
import { validateInitialGroupPresenceSummaryCandidate } from '../presence/group-initial-presence-summary.ts';
import { validateGroupEvent } from '../../persisted-group-event.ts';

const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export function validateGroupMutationIdempotencyRecord(record: unknown, ref: GroupRef): asserts record is GroupMutationIdempotencyRecord {
  const value = requireRecord(record, 'Stored group idempotency value');
  assertExactKeys(value, ['aggregateRef', 'requestId', 'commandHash', 'receipt'], 'Stored group idempotency value');
  assertRequiredKeys(value, ['aggregateRef', 'requestId', 'commandHash', 'receipt'], 'Stored group idempotency value');
  validateGroupRef(value.aggregateRef);
  validateScopedValue(value.aggregateRef as GroupRef, ref, 'Stored group idempotency aggregateRef');
  requireNonEmptyString(value.requestId, 'Stored group idempotency requestId');
  validateCommandHash(value.commandHash, 'Stored group idempotency commandHash');
  validateMutationReceipt(value.receipt, ref, 'Stored group idempotency receipt');
  const receipt = value.receipt as GroupMutationReceipt;
  if (receipt.commandHash !== value.commandHash) {
    throw new TypeError('Stored group idempotency hashes differ');
  }
  if (receipt.commandId !== value.requestId) {
    throw new TypeError('Stored group idempotency receipt command differs from request identity');
  }
  if (
    receipt.requestId !== value.requestId ||
    receipt.aggregateRef.applicationId !== ref.applicationId ||
    receipt.aggregateRef.workspaceId !== ref.workspaceId ||
    receipt.aggregateRef.groupId !== ref.groupId
  ) {
    throw new TypeError('Stored group idempotency receipt differs from request identity');
  }
}

export function validateMutationReceipt(value: unknown, ref: GroupRef, label: string): void {
  const receipt = requireRecord(value, label);
  assertExactKeys(
    receipt,
    [
      'commandId',
      'requestId',
      'commandHash',
      'aggregateRef',
      'outcome',
      'attemptCount',
      'acceptedStorageRevision',
      'stateRevision',
      'snapshotVersion',
      'causalRevision',
      'eventId',
      'outboxIds',
      'joinCode',
      'joinCodeExpiresAtEpochMs',
      'rejection',
    ],
    label,
  );
  assertRequiredKeys(
    receipt,
    [
      'commandId',
      'requestId',
      'commandHash',
      'aggregateRef',
      'outcome',
      'attemptCount',
      'acceptedStorageRevision',
      'stateRevision',
      'snapshotVersion',
      'causalRevision',
      'eventId',
      'outboxIds',
      'joinCode',
      'joinCodeExpiresAtEpochMs',
      'rejection',
    ],
    label,
  );
  requireNonEmptyString(receipt.commandId, `${label} commandId`);
  nullableNonEmptyString(receipt.requestId, `${label} requestId`);
  validateCommandHash(receipt.commandHash, `${label} commandHash`);
  const aggregateRef = receipt.aggregateRef;
  validateGroupRef(aggregateRef);
  validateScopedValue(aggregateRef, ref, `${label} aggregateRef`);
  requireOneOf(receipt.outcome, ['applied', 'no-op', 'rejected'], `${label} outcome`);
  requirePositiveSafeInteger(receipt.attemptCount, `${label} attemptCount`);
  if (receipt.acceptedStorageRevision !== null) {
    requireNonNegativeSafeInteger(receipt.acceptedStorageRevision, `${label} acceptedStorageRevision`);
  }
  requireNonNegativeSafeInteger(receipt.stateRevision, `${label} stateRevision`);
  requireNonNegativeSafeInteger(receipt.snapshotVersion, `${label} snapshotVersion`);
  const causalRevision = receipt.causalRevision;
  validateCausalRevision(causalRevision, label);
  if (receipt.snapshotVersion !== causalRevision.groupRevision) throw new TypeError(`${label} snapshotVersion differs from causalRevision`);
  if (receipt.stateRevision !== toGroupSnapshotStateRevision(causalRevision.groupRevision, causalRevision.presenceRevision)) {
    throw new TypeError(`${label} stateRevision differs from causalRevision`);
  }
  nullableNonEmptyString(receipt.eventId, `${label} eventId`);
  if (!Array.isArray(receipt.outboxIds)) {
    throw new TypeError(`${label} outboxIds is invalid`);
  }
  for (const outboxId of receipt.outboxIds) {
    requireNonEmptyString(outboxId, `${label} outboxId`);
  }
  if ((receipt.outcome === 'applied') !== (receipt.eventId !== null)) {
    throw new TypeError(`${label} event differs from outcome`);
  }
  if (receipt.joinCode !== null) {
    requireNonEmptyString(receipt.joinCode, `${label} joinCode`);
  }
  if (receipt.joinCodeExpiresAtEpochMs !== null) {
    requirePositiveSafeInteger(receipt.joinCodeExpiresAtEpochMs, `${label} joinCodeExpiresAtEpochMs`);
  }
  if ((receipt.joinCode === null) !== (receipt.joinCodeExpiresAtEpochMs === null)) {
    throw new TypeError(`${label} join-code fields must have matching presence`);
  }
  if (receipt.rejection !== null) {
    requireNonEmptyString(receipt.rejection, `${label} rejection`);
  }
  if ((receipt.outcome === 'rejected') !== (receipt.rejection !== null)) {
    throw new TypeError(`${label} rejection differs from outcome`);
  }
  if (receipt.outcome === 'applied') {
    if (receipt.acceptedStorageRevision === null) {
      throw new TypeError(`${label} acceptedStorageRevision is required when applied`);
    }
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label} applied snapshotVersion`);
    requirePositiveSafeInteger(causalRevision.groupRevision, `${label} applied groupRevision`);
    if (receipt.outboxIds.length !== 1) {
      throw new TypeError(`${label} outboxIds differs from applied outcome`);
    }
    return;
  }
  if (receipt.outboxIds.length !== 0) {
    throw new TypeError(`${label} outboxIds differs from non-applied outcome`);
  }
  if (receipt.joinCode !== null || receipt.joinCodeExpiresAtEpochMs !== null) {
    throw new TypeError(`${label} join-code fields require an applied outcome`);
  }
  if (receipt.outcome === 'no-op') {
    requirePositiveSafeInteger(receipt.snapshotVersion, `${label} no-op snapshotVersion`);
    if (receipt.acceptedStorageRevision === null || causalRevision.groupRevision !== receipt.acceptedStorageRevision + 1) {
      throw new TypeError(`${label} no-op revision differs from its predecessor`);
    }
    return;
  }
  if (receipt.acceptedStorageRevision === null) {
    if (causalRevision.groupRevision !== 0 || causalRevision.presenceRevision !== 0 || receipt.snapshotVersion !== 0) {
      throw new TypeError(`${label} absent-group rejection has authority`);
    }
    return;
  }
  requirePositiveSafeInteger(receipt.snapshotVersion, `${label} rejected snapshotVersion`);
  if (causalRevision.groupRevision !== receipt.acceptedStorageRevision + 1) {
    throw new TypeError(`${label} rejected revision differs from its predecessor`);
  }
}

export function validateCommandHash(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

export function materializedRotateJoinCode(
  command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
  facts: GroupMutationFacts,
): Readonly<{ joinCode: string; expiresAtEpochMs: number }> {
  const joinCode = command.input.joinCode ?? facts.resolvedJoinCode;
  const expiresAtEpochMs = command.input.expiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
  if (!joinCode || !Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
    throw new GroupMutationRejectedError('Join code defaults could not be materialized safely');
  }
  return { joinCode, expiresAtEpochMs };
}

export function writeResult(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  input: Readonly<{
    guard: GroupGuardCandidate | PresenceGuardCandidate;
    members: readonly GroupMember[];
    initialPresenceSummary: InitialGroupPresenceSummaryCandidate | null;
    presenceAdmission?: PresenceAdmissionCandidate | null;
    eventType: GroupEventType;
    eventGroup?: Group;
  }>,
): GroupMutationComputed {
  const group = input.eventGroup ?? (input.guard.kind === 'group' ? input.guard.value : requireGroup(read, command.aggregateRef).value);
  const groupRevision = group.snapshotVersion;
  const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
  const causalRevision = { groupRevision, presenceRevision };
  const event = newGroupEvent(input.eventType, group, causalRevision, command, facts);
  const outboxEntry = computeGroupPresenceSummaryEntry(
    {
      effectKind: 'group-presence-summary',
      aggregateRef: command.aggregateRef,
      commandId: command.commandId,
      createdAtEpochMs: facts.nowEpochMs,
      expireAtEpochMs: facts.expireAtEpochMs,
      acceptedCausalRevision: causalRevision,
      event,
    },
    facts.serviceId,
  );
  const receipt = receiptFor(command, facts, {
    outcome: 'applied',
    causalRevision,
    snapshotVersion: group.snapshotVersion,
    acceptedStorageRevision: input.guard.operation === 'insert' ? 0 : input.guard.expectedRevision + 1,
    eventId: event.eventId,
    outboxIds: [outboxEntry.key.resourceId],
    rejection: null,
  });
  const idempotency =
    command.requestId === null
      ? null
      : {
          aggregateRef: command.aggregateRef,
          requestId: command.requestId,
          commandHash: facts.commandHash,
          receipt,
        };
  return {
    outcome: 'write',
    guard: input.guard,
    members: input.members,
    initialPresenceSummary: input.initialPresenceSummary,
    presenceAdmission: input.presenceAdmission ?? null,
    event,
    receipt,
    idempotency,
    outboxEntries: [outboxEntry],
  };
}

export function noOp(command: GroupMutationCommand, read: GroupMutationRead, facts: GroupMutationFacts): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  const causalRevision = currentCausalRevision(read);
  return {
    outcome: 'no-op',
    receipt: receiptFor(command, facts, {
      outcome: 'no-op',
      causalRevision,
      snapshotVersion: stored.value.snapshotVersion,
      acceptedStorageRevision: stored.entry.revision,
      eventId: null,
      outboxIds: [],
      rejection: null,
    }),
  };
}

export function rejected(command: GroupMutationCommand, read: GroupMutationRead, facts: GroupMutationFacts, message: string): GroupMutationComputed {
  const causalRevision = currentCausalRevision(read);
  return {
    outcome: 'rejected',
    receipt: receiptFor(command, facts, {
      outcome: 'rejected',
      causalRevision,
      snapshotVersion: read.group?.value.snapshotVersion ?? 0,
      acceptedStorageRevision: read.group?.entry.revision ?? null,
      eventId: null,
      outboxIds: [],
      rejection: message,
    }),
  };
}

export function receiptFor(
  command: GroupMutationCommand,
  facts: GroupMutationFacts,
  input: Readonly<{
    outcome: GroupMutationReceipt['outcome'];
    causalRevision: GroupStateCausalRevision;
    snapshotVersion: number;
    acceptedStorageRevision: number | null;
    eventId: string | null;
    outboxIds: readonly string[];
    rejection: string | null;
  }>,
): GroupMutationReceipt {
  const joinCode = command.operation === 'rotateGroupJoinCode' ? materializedRotateJoinCode(command, facts) : null;
  return {
    commandId: command.commandId,
    requestId: command.requestId,
    commandHash: facts.commandHash,
    aggregateRef: command.aggregateRef,
    outcome: input.outcome,
    attemptCount: facts.attemptCount,
    acceptedStorageRevision: input.acceptedStorageRevision,
    stateRevision: toGroupSnapshotStateRevision(input.causalRevision.groupRevision, input.causalRevision.presenceRevision),
    snapshotVersion: input.snapshotVersion,
    causalRevision: input.causalRevision,
    eventId: input.eventId,
    outboxIds: input.outboxIds,
    joinCode: joinCode?.joinCode ?? null,
    joinCodeExpiresAtEpochMs: joinCode?.expiresAtEpochMs ?? null,
    rejection: input.rejection,
  };
}

export function currentCausalRevision(read: GroupMutationRead): GroupStateCausalRevision {
  return {
    groupRevision: read.group?.value.snapshotVersion ?? 0,
    presenceRevision: read.presenceSummary?.value.causalRevision.presenceRevision ?? 0,
  };
}

export function requireGroup(read: GroupMutationRead, ref: GroupRef): RuntimeStateEntryValue<Group> {
  if (!read.group) throw new GroupMutationRejectedError(`Group not found: ${ref.groupId}`);
  return read.group;
}

export function auditStamp(command: GroupMutationCommand, facts: GroupMutationFacts, fallbackPrincipalId: string | undefined): AuditStamp {
  return {
    atEpochMs: facts.nowEpochMs,
    actor: mutationActor(command, facts, fallbackPrincipalId),
    reason: command.input.reason,
    traceId: command.input.traceId,
    requestId: command.requestId,
  };
}

export function mutationActor(command: GroupMutationCommand, facts: GroupMutationFacts, fallbackPrincipalId?: string): MutationActor {
  const principalId = command.input.actorPrincipalId ?? fallbackPrincipalId;
  if (command.input.actorSessionId !== null) {
    if (!principalId) {
      throw new GroupMutationRejectedError('A session actor requires a principal identity.');
    }
    return {
      kind: 'session',
      sessionId: command.input.actorSessionId,
      principalId,
    };
  }
  if (principalId) return { kind: 'principal', principalId };
  return { kind: 'service', serviceId: facts.serviceId };
}

export function newGroupEvent(
  eventType: GroupEventType,
  group: Group,
  causalRevision: GroupStateCausalRevision,
  command: GroupMutationCommand,
  facts: GroupMutationFacts,
): GroupEvent {
  return {
    applicationId: group.applicationId,
    workspaceId: group.workspaceId,
    groupId: group.groupId,
    eventId: facts.eventId,
    eventType,
    snapshotVersion: group.snapshotVersion,
    causalRevision,
    occurredAtEpochMs: facts.nowEpochMs,
    actor: mutationActor(command, facts),
    reason: command.input.reason,
    traceId: command.input.traceId,
    requestId: command.requestId,
    payload: {},
  };
}
