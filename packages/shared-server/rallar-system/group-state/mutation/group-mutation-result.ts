import type {
  AuditStamp,
  Group,
  GroupEvent,
  GroupEventType,
  GroupMember,
  GroupRef,
  GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import { toGroupSnapshotStateRevision } from '@shared/api/group-client-views.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';
// prettier-ignore
import {
  computeGroupPresenceSummaryEntry,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';

import type {
  GroupGuardCandidate,
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
  GroupMutationReceipt,
  PresenceAdmissionCandidate,
  PresenceGuardCandidate,
} from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';
// prettier-ignore
import type {
  InitialGroupPresenceSummaryCandidate,
} from '../presence/group-initial-presence-summary.ts';

const DEFAULT_GROUP_JOIN_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export interface GroupMutationWriteInput {
  readonly command: GroupMutationCommand;
  readonly read: GroupMutationRead;
  readonly facts: GroupMutationFacts;
  readonly guard: GroupGuardCandidate | PresenceGuardCandidate;
  readonly members: readonly GroupMember[];
  readonly initialPresenceSummary: InitialGroupPresenceSummaryCandidate | null;
  readonly presenceAdmission?: PresenceAdmissionCandidate | null;
  readonly eventType: GroupEventType;
  readonly eventGroup?: Group;
}

export interface RejectedGroupMutationInput {
  readonly command: GroupMutationCommand;
  readonly read: GroupMutationRead;
  readonly facts: GroupMutationFacts;
  readonly message: string;
}

export interface NewGroupEventInput {
  readonly eventType: GroupEventType;
  readonly group: Group;
  readonly causalRevision: GroupStateCausalRevision;
  readonly command: GroupMutationCommand;
  readonly facts: GroupMutationFacts;
}

export function materializedRotateJoinCode(
  command: Extract<GroupMutationCommand, { operation: 'rotateGroupJoinCode' }>,
  facts: GroupMutationFacts,
): Readonly<{ joinCode: string; expiresAtEpochMs: number }> {
  const joinCode = command.input.joinCode ?? facts.resolvedJoinCode;
  const expiresAtEpochMs =
    command.input.expiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_JOIN_CODE_TTL_MS;
  if (!joinCode || !Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= 0) {
    throw new GroupMutationRejectedError('Join code defaults could not be materialized safely');
  }
  return { joinCode, expiresAtEpochMs };
}

export function computeGroupMutationWrite(input: GroupMutationWriteInput): GroupMutationComputed {
  const { command, facts, read } = input;
  const group =
    input.eventGroup ??
    (input.guard.kind === 'group'
      ? input.guard.value
      : requireGroup(read, command.aggregateRef).value);
  const groupRevision = group.snapshotVersion;
  const presenceRevision = read.presenceSummary?.value.causalRevision.presenceRevision ?? 0;
  const causalRevision = { groupRevision, presenceRevision };
  const event = newGroupEvent({
    eventType: input.eventType,
    group,
    causalRevision,
    command,
    facts,
  });
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
    acceptedStorageRevision:
      input.guard.operation === 'insert' ? 0 : input.guard.expectedRevision + 1,
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

export function noOp(
  command: GroupMutationCommand,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
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

export function rejected(input: RejectedGroupMutationInput): GroupMutationComputed {
  const { command, facts, message, read } = input;
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
  const joinCode =
    command.operation === 'rotateGroupJoinCode' ? materializedRotateJoinCode(command, facts) : null;
  return {
    commandId: command.commandId,
    requestId: command.requestId,
    commandHash: facts.commandHash,
    aggregateRef: command.aggregateRef,
    outcome: input.outcome,
    attemptCount: facts.attemptCount,
    acceptedStorageRevision: input.acceptedStorageRevision,
    stateRevision: toGroupSnapshotStateRevision(
      input.causalRevision.groupRevision,
      input.causalRevision.presenceRevision,
    ),
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

export function requireGroup(
  read: GroupMutationRead,
  ref: GroupRef,
): RuntimeStateEntryValue<Group> {
  if (!read.group) throw new GroupMutationRejectedError(`Group not found: ${ref.groupId}`);
  return read.group;
}

export function auditStamp(
  command: GroupMutationCommand,
  facts: GroupMutationFacts,
  fallbackPrincipalId: string | undefined,
): AuditStamp {
  return {
    atEpochMs: facts.nowEpochMs,
    actor: mutationActor(command, facts, fallbackPrincipalId),
    reason: command.input.reason,
    traceId: command.input.traceId,
    requestId: command.requestId,
  };
}

export function mutationActor(
  command: GroupMutationCommand,
  facts: GroupMutationFacts,
  fallbackPrincipalId?: string,
): MutationActor {
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

export function newGroupEvent(input: NewGroupEventInput): GroupEvent {
  const { causalRevision, command, eventType, facts, group } = input;
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
