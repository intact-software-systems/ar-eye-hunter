import type { GroupEventType, GroupMember, GroupPresenceAdmission, GroupPresenceSession, GroupRef } from '@shared/api/group-types.ts';
import { canConnectGroupPresenceSession, GroupPolicyDeniedError } from '../../group-policy.ts';
import { jsonEquals } from '@shared/repository/state-utils.ts';

import type {
  GroupMutationCommand,
  GroupMutationComputed,
  GroupMutationFacts,
  GroupMutationRead,
  PresenceAdmissionCandidate,
} from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';
import { assertActive, assertAllowed, isExactlyAdmitted, toPolicySnapshot } from './compute-group-aggregate-mutation.ts';
import { noOp, requireGroup, writeResult } from './group-mutation-result.ts';
import {
  compareGenerationOrder,
  validatePresenceAdmission,
  validatePresenceSession,
  validateStoredGeneration,
} from '../persistence/validate-persisted-group-presence.ts';
import { requirePositiveSafeInteger } from './group-state-validation-primitives.ts';
import { toExpiredAwareInsertCandidate } from '../../services/group-expired-state-authority.ts';

const DEFAULT_GROUP_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export function assertPrincipalAuthority(command: GroupMutationCommand, principalId: string): void {
  if (command.input.actorPrincipalId !== principalId) {
    throw new GroupPolicyDeniedError({
      allowed: false,
      code: 'member-not-active',
      message: 'Mutation actor must match the authoritative principal.',
    });
  }
}

export function admissionForMemberWrite(
  read: GroupMutationRead,
  members: readonly GroupMember[],
  facts: GroupMutationFacts,
): PresenceAdmissionCandidate | null {
  const current = read.targetAdmission;
  const target = members.find((member) => member.status !== 'active');
  if (!target) return null;
  if (current) {
    validatePresenceAdmission(current.value);
    if (current.value.principalId !== target.principalId) {
      throw new TypeError('Presence admission predecessor differs from member authority target');
    }
  }
  const previousUpdatedAt = current?.value.updatedAtEpochMs ?? 0;
  if (previousUpdatedAt >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Presence admission fence timestamp cannot advance');
  }
  const value: GroupPresenceAdmission = {
    ...commandRefForAdmission(target),
    admittedSessions: [],
    updatedAtEpochMs: Math.max(previousUpdatedAt + 1, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return current
    ? {
        operation: 'update',
        value,
        expectedRevision: current.entry.revision,
      }
    : { operation: 'insert', value };
}

function commandRefForAdmission(member: GroupMember): GroupRef & Readonly<{ principalId: string }> {
  return {
    applicationId: member.applicationId,
    workspaceId: member.workspaceId,
    groupId: member.groupId,
    principalId: member.principalId,
  };
}

export function computeConnectPresence(
  command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  assertPrincipalAuthority(command, command.input.principalId);
  const member = read.targetMember ?? undefined;
  if (!member || member.status !== 'active') {
    throw new GroupMutationRejectedError(`Forbidden: active group member required for presence: ${command.input.principalId}`);
  }
  assertAllowed(
    canConnectGroupPresenceSession({
      snapshot: toPolicySnapshot(read, facts.nowEpochMs),
      actor: {
        principalId: command.input.principalId,
        sessionId: command.input.actorSessionId ?? undefined,
      },
      sessionId: command.sessionId,
      nowEpochMs: facts.nowEpochMs,
    }),
  );
  const existing = read.targetPresence;
  const connectedAt =
    existing?.value.generationId === command.input.generationId && command.input.connectedAtEpochMs === null
      ? existing.value.connectedAtEpochMs
      : (command.input.connectedAtEpochMs ?? facts.nowEpochMs);
  requirePositiveSafeInteger(connectedAt, 'Group presence connectedAtEpochMs');
  // connectedAt is the durable generation version. The generation id only
  // breaks equal-timestamp ties, so every writer derives the same total order.
  const incomingOrder = [connectedAt, command.input.generationId] as const;
  if (existing) {
    validateStoredGeneration(existing.value);
    if (existing.value.principalId !== command.input.principalId) {
      throw new GroupMutationRejectedError('A presence session cannot be reassigned to another principal.');
    }
    const currentOrder = [existing.value.generationVersion, existing.value.generationId] as const;
    const order = compareGenerationOrder(incomingOrder, currentOrder);
    if (order < 0) return noOp(command, read, facts);
    if (order === 0 && existing.value.disconnectedAtEpochMs !== null) {
      return noOp(command, read, facts);
    }
    if (
      existing.value.generationId === command.input.generationId &&
      command.input.connectedAtEpochMs !== null &&
      connectedAt !== existing.value.connectedAtEpochMs
    ) {
      throw new GroupMutationRejectedError('A generationId cannot be reused with a different connectedAtEpochMs.');
    }
  }
  const sameGeneration = existing !== null && existing.value.generationId === command.input.generationId && existing.value.generationVersion === connectedAt;
  const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
  const expiresAt = command.input.expiresAtEpochMs ?? facts.nowEpochMs + DEFAULT_GROUP_SESSION_TTL_MS;
  if (heartbeatAt < connectedAt || expiresAt < heartbeatAt) {
    throw new GroupMutationRejectedError('Presence connection timestamps are causally inconsistent.');
  }
  const session: GroupPresenceSession = {
    ...command.aggregateRef,
    sessionId: command.sessionId,
    principalId: command.input.principalId,
    generationId: command.input.generationId,
    generationVersion: connectedAt,
    connectedAtEpochMs: sameGeneration ? existing.value.connectedAtEpochMs : connectedAt,
    lastHeartbeatAtEpochMs: sameGeneration ? Math.max(existing.value.lastHeartbeatAtEpochMs, heartbeatAt) : heartbeatAt,
    expiresAtEpochMs: sameGeneration ? Math.max(existing.value.expiresAtEpochMs, expiresAt) : expiresAt,
    status: 'active',
    disconnectedAtEpochMs: null,
    disconnectReason: null,
  };
  if (existing && jsonEquals(existing.value, session)) return noOp(command, read, facts);
  const admission = admissionForConnect(command, read, session, facts);
  return presenceWrite(command, read, facts, session, existing ? 'update' : 'insert', 'session-connected', admission);
}

export function computeHeartbeatPresence(
  command: Extract<GroupMutationCommand, { operation: 'heartbeatPresence' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  const group = requireGroup(read, command.aggregateRef);
  assertActive(group.value, facts.nowEpochMs);
  const existing = read.targetPresence;
  if (!existing) throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
  assertPresenceAuthority(command, existing.value.principalId, facts);
  if (existing.value.generationId !== command.input.generationId || existing.value.disconnectedAtEpochMs !== null) return noOp(command, read, facts);
  if (!isExactlyAdmitted(read.targetAdmission?.value, existing.value)) {
    return noOp(command, read, facts);
  }
  const member = read.targetMember ?? undefined;
  if (!member || member.status !== 'active') return noOp(command, read, facts);
  const heartbeatAt = command.input.lastHeartbeatAtEpochMs ?? facts.nowEpochMs;
  if (heartbeatAt < existing.value.lastHeartbeatAtEpochMs) return noOp(command, read, facts);
  const expiresAt = Math.max(existing.value.expiresAtEpochMs, command.input.expiresAtEpochMs ?? existing.value.expiresAtEpochMs);
  if (expiresAt < heartbeatAt) {
    throw new GroupMutationRejectedError('Presence heartbeat expiry must not predate the heartbeat.');
  }
  const session: GroupPresenceSession = {
    ...existing.value,
    lastHeartbeatAtEpochMs: heartbeatAt,
    expiresAtEpochMs: expiresAt,
  };
  if (jsonEquals(existing.value, session)) return noOp(command, read, facts);
  return presenceWrite(command, read, facts, session, 'update', 'session-heartbeat');
}

export function computeDisconnectPresence(
  command: Extract<GroupMutationCommand, { operation: 'disconnectPresence' }>,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
): GroupMutationComputed {
  requireGroup(read, command.aggregateRef);
  const existing = read.targetPresence;
  if (!existing) {
    if (facts.internalAuthority === 'expiry') return noOp(command, read, facts);
    throw new GroupMutationRejectedError(`Group presence session not found: ${command.sessionId}`);
  }
  assertPresenceAuthority(command, existing.value.principalId, facts);
  if (
    existing.value.generationId !== command.input.generationId ||
    (command.input.generationVersion !== null && existing.value.generationVersion !== command.input.generationVersion) ||
    (command.input.observedExpiresAtEpochMs !== null && existing.value.expiresAtEpochMs !== command.input.observedExpiresAtEpochMs) ||
    existing.value.disconnectedAtEpochMs !== null
  )
    return noOp(command, read, facts);
  const disconnectedAt = command.input.disconnectedAtEpochMs ?? facts.nowEpochMs;
  if (disconnectedAt < existing.value.lastHeartbeatAtEpochMs) {
    return noOp(command, read, facts);
  }
  if (facts.internalAuthority === 'expiry') {
    return presenceWrite(command, read, facts, existing.value, 'delete', 'session-disconnected', admissionForDisconnect(read, existing.value, facts));
  }
  const session: GroupPresenceSession = {
    ...existing.value,
    status: 'disconnected',
    disconnectedAtEpochMs: disconnectedAt,
    disconnectReason: command.input.reason ?? 'closed',
  };
  return presenceWrite(command, read, facts, session, 'update', 'session-disconnected', admissionForDisconnect(read, existing.value, facts));
}

function presenceWrite(
  command: Extract<
    GroupMutationCommand,
    {
      operation: 'connectPresence' | 'heartbeatPresence' | 'disconnectPresence';
    }
  >,
  read: GroupMutationRead,
  facts: GroupMutationFacts,
  session: GroupPresenceSession,
  operation: 'insert' | 'update' | 'delete',
  eventType: GroupEventType,
  presenceAdmission: PresenceAdmissionCandidate | null = null,
): GroupMutationComputed {
  const stored = requireGroup(read, command.aggregateRef);
  const guard =
    operation === 'insert'
      ? ({
          kind: 'presence',
          ...toExpiredAwareInsertCandidate(read.expiredTargetPresenceEntry, session),
        } as const)
      : operation === 'update'
        ? ({
            kind: 'presence',
            operation: 'update',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
          } as const)
        : ({
            kind: 'presence',
            operation: 'delete',
            value: session,
            expectedRevision: read.targetPresence!.entry.revision,
          } as const);
  return writeResult(command, read, facts, {
    guard,
    members: [],
    initialPresenceSummary: null,
    eventType,
    eventGroup: stored.value,
    presenceAdmission,
  });
}

function assertPresenceAuthority(command: GroupMutationCommand, principalId: string, facts: GroupMutationFacts): void {
  if (facts.internalAuthority !== 'none') return;
  assertPrincipalAuthority(command, principalId);
}

function admissionForConnect(
  command: Extract<GroupMutationCommand, { operation: 'connectPresence' }>,
  read: GroupMutationRead,
  session: GroupPresenceSession,
  facts: GroupMutationFacts,
): PresenceAdmissionCandidate {
  const current = read.targetAdmission;
  if (current) validatePresenceAdmission(current.value);
  const retained = (current?.value.admittedSessions ?? []).filter((entry) => entry.sessionId !== session.sessionId);
  const admittedSessions = [
    ...retained,
    {
      sessionId: session.sessionId,
      generationId: session.generationId,
      generationVersion: session.generationVersion,
      connectedAtEpochMs: session.connectedAtEpochMs,
    },
  ].toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
  const cap = requireGroup(read, command.aggregateRef).value.maxSessionsPerMember;
  if (cap !== null && admittedSessions.length > cap) {
    throw new GroupPolicyDeniedError({
      allowed: false,
      code: 'member-session-limit-reached',
      message: 'Group member session capacity has been reached.',
    });
  }
  const value: GroupPresenceAdmission = {
    ...command.aggregateRef,
    principalId: session.principalId,
    admittedSessions,
    updatedAtEpochMs: Math.max(current?.value.updatedAtEpochMs ?? 0, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return current ? { operation: 'update', value, expectedRevision: current.entry.revision } : { operation: 'insert', value };
}

function admissionForDisconnect(read: GroupMutationRead, session: GroupPresenceSession, facts: GroupMutationFacts): PresenceAdmissionCandidate | null {
  const current = read.targetAdmission;
  if (!current || !isExactlyAdmitted(current.value, session)) return null;
  const value: GroupPresenceAdmission = {
    ...current.value,
    admittedSessions: current.value.admittedSessions.filter((entry) => entry.sessionId !== session.sessionId),
    updatedAtEpochMs: Math.max(current.value.updatedAtEpochMs, facts.nowEpochMs),
  };
  validatePresenceAdmission(value);
  return {
    operation: 'update',
    value,
    expectedRevision: current.entry.revision,
  };
}

export function admissionIdentity(principalId: string, session: Pick<GroupPresenceSession, 'sessionId' | 'generationId' | 'generationVersion'>): string {
  return JSON.stringify([principalId, session.sessionId, session.generationId, session.generationVersion]);
}
