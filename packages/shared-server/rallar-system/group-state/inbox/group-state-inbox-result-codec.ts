import {
  validateAuthoritativeGroupEvent,
  validateAuthoritativeGroupSnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
  requireExactKeys,
  requireOneOf,
  requireString,
} from '../../services/exact-object-codec.ts';
import type { JsonWireObject, JsonWireValue } from '../../services/mutation-command-identity.ts';
import { AppInboxType } from '../../services/app-inbox-contracts.ts';
import type {
  GroupJoinCodeMutationWritten,
  GroupJoinCodeWritten,
  GroupStateWritten,
} from '../group-state-service-contracts.ts';
import type { GroupMutationReceipt } from '../mutation/group-mutation-contracts.ts';
import type { InactiveGroupPresenceResult } from '../presence/group-presence-service.ts';
import type { GroupStateInboxDurableResult } from './group-state-inbox-result.ts';

const GROUP_PRESENCE_RESULT_TYPES: ReadonlySet<AppInboxType> = new Set([
  AppInboxType.GROUP_PRESENCE_CONNECT,
  AppInboxType.GROUP_PRESENCE_HEARTBEAT,
  AppInboxType.GROUP_PRESENCE_DISCONNECT,
]);

export function decodeGroupStateInboxDurableResult(
  value: JsonWireValue,
  type: AppInboxType,
): GroupStateInboxDurableResult {
  if (GROUP_PRESENCE_RESULT_TYPES.has(type)) {
    const result = requireJsonWireRecord(value, 'Group presence result');
    return result.status === 'inactive'
      ? decodeInactiveGroupPresenceResult(result)
      : decodeGroupMutationReceipt(value);
  }
  if (type === AppInboxType.GROUP_JOIN_CODE_ROTATE) {
    return decodeGroupJoinCodeWritten(value);
  }
  return decodeGroupStateWritten(value);
}

export function decodeGroupStateWritten(value: JsonWireValue): GroupStateWritten {
  const written = requireJsonWireRecord(value, 'Group state result');
  requireExactKeys(written, ['status', 'result'], 'Group state result');
  const status = requireOneOf(
    written.status,
    ['created', 'ok', 'error'] as const,
    'Group state result status',
  );
  const result = decodeGroupMutationEither(written.result);
  if ((status === 'error') !== (result.left !== undefined)) {
    throw new TypeError('Group state result status differs from its result');
  }
  return { status, result };
}

export function decodeGroupJoinCodeWritten(value: JsonWireValue): GroupJoinCodeWritten {
  const written = requireJsonWireRecord(value, 'Group join-code result');
  requireExactKeys(written, ['status', 'result'], 'Group join-code result');
  const status = requireOneOf(
    written.status,
    ['ok', 'error'] as const,
    'Group join-code result status',
  );
  const result = decodeGroupJoinCodeEither(written.result);
  if ((status === 'error') !== (result.left !== undefined)) {
    throw new TypeError('Group join-code result status differs from its result');
  }
  return { status, result };
}

export function decodeGroupMutationReceipt(value: JsonWireValue): GroupMutationReceipt {
  const receipt = requireJsonWireRecord(value, 'Group mutation receipt');
  requireExactKeys(
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
    'Group mutation receipt',
  );
  requireString(receipt.commandId, 'Group mutation receipt commandId');
  const requestId = requireNullableString(receipt.requestId, 'Group mutation receipt requestId');
  requireString(receipt.commandHash, 'Group mutation receipt commandHash');
  const aggregateRef = decodeGroupRef(receipt.aggregateRef);
  const outcome = requireOneOf(
    receipt.outcome,
    ['applied', 'no-op', 'rejected'] as const,
    'Group mutation receipt outcome',
  );
  const attemptCount = requireNonNegativeInteger(
    receipt.attemptCount,
    'Group mutation receipt attemptCount',
  );
  const acceptedStorageRevision = requireNullableNonNegativeInteger(
    receipt.acceptedStorageRevision,
    'Group mutation receipt acceptedStorageRevision',
  );
  const stateRevision = requireNonNegativeInteger(
    receipt.stateRevision,
    'Group mutation receipt stateRevision',
  );
  const snapshotVersion = requireNonNegativeInteger(
    receipt.snapshotVersion,
    'Group mutation receipt snapshotVersion',
  );
  const causalRevision = decodeCausalRevision(receipt.causalRevision);
  const eventId = requireNullableString(receipt.eventId, 'Group mutation receipt eventId');
  const outboxIds = decodeStringArray(receipt.outboxIds, 'Group mutation receipt outboxIds');
  const joinCode = requireNullableString(receipt.joinCode, 'Group mutation receipt joinCode');
  const joinCodeExpiresAtEpochMs = requireNullableNonNegativeInteger(
    receipt.joinCodeExpiresAtEpochMs,
    'Group mutation receipt joinCodeExpiresAtEpochMs',
  );
  const rejection = requireNullableString(receipt.rejection, 'Group mutation receipt rejection');
  return {
    commandId: receipt.commandId,
    requestId,
    commandHash: receipt.commandHash,
    aggregateRef,
    outcome,
    attemptCount,
    acceptedStorageRevision,
    stateRevision,
    snapshotVersion,
    causalRevision,
    eventId,
    outboxIds,
    joinCode,
    joinCodeExpiresAtEpochMs,
    rejection,
  };
}

function decodeInactiveGroupPresenceResult(value: JsonWireObject): InactiveGroupPresenceResult {
  requireExactKeys(
    value,
    ['status', 'sessionId', 'generationId'],
    'Inactive group presence result',
  );
  if (value.status !== 'inactive') {
    throw new TypeError('Inactive group presence result status is invalid');
  }
  requireString(value.sessionId, 'Inactive group presence result sessionId');
  requireString(value.generationId, 'Inactive group presence result generationId');
  return {
    status: value.status,
    sessionId: value.sessionId,
    generationId: value.generationId,
  };
}

export function requireGroupStateWritten(result: GroupStateInboxDurableResult): GroupStateWritten {
  if ('commandId' in result || result.status === 'inactive' || isJoinCodeSuccess(result)) {
    throw new TypeError('Expected a group state mutation result');
  }
  return result;
}

export function requireGroupJoinCodeWritten(
  result: GroupStateInboxDurableResult,
): GroupJoinCodeWritten {
  if (
    'commandId' in result ||
    result.status === 'inactive' ||
    result.status === 'created' ||
    isGroupStateSuccess(result)
  ) {
    throw new TypeError('Expected a group join-code mutation result');
  }
  return result;
}

export function requireGroupMutationReceipt(
  result: GroupStateInboxDurableResult,
): GroupMutationReceipt {
  if (!('commandId' in result)) {
    throw new TypeError('Expected a group mutation receipt');
  }
  return result;
}

function decodeGroupMutationEither(value: JsonWireValue): GroupStateWritten['result'] {
  const result = requireJsonWireRecord(value, 'Group state mutation result');
  if (Object.hasOwn(result, 'left')) {
    requireExactKeys(result, ['left'], 'Group state mutation result');
    requireString(result.left, 'Group state mutation result left');
    return Either.ofLeft(result.left);
  }
  requireExactKeys(result, ['right'], 'Group state mutation result');
  const written = requireJsonWireRecord(result.right, 'Group state mutation result right');
  requireExactKeys(written, ['snapshot', 'event'], 'Group state mutation result right');
  validateAuthoritativeGroupSnapshot(written.snapshot);
  if (written.event !== null) {
    validateAuthoritativeGroupEvent(written.event, {
      applicationId: written.snapshot.group.applicationId,
      workspaceId: written.snapshot.group.workspaceId,
      groupId: written.snapshot.group.groupId,
    });
  }
  return Either.ofRight({ snapshot: written.snapshot, event: written.event });
}

function isJoinCodeSuccess(
  result: GroupStateWritten | GroupJoinCodeWritten,
): result is GroupJoinCodeWritten {
  return result.result.right !== undefined && 'joinCode' in result.result.right;
}

function isGroupStateSuccess(
  result: GroupStateWritten | GroupJoinCodeWritten,
): result is GroupStateWritten {
  return result.result.right !== undefined && !('joinCode' in result.result.right);
}

function decodeGroupJoinCodeEither(value: JsonWireValue): GroupJoinCodeWritten['result'] {
  const result = requireJsonWireRecord(value, 'Group join-code mutation result');
  if (Object.hasOwn(result, 'left')) {
    requireExactKeys(result, ['left'], 'Group join-code mutation result');
    requireString(result.left, 'Group join-code mutation result left');
    return Either.ofLeft(result.left);
  }
  requireExactKeys(result, ['right'], 'Group join-code mutation result');
  return Either.ofRight(decodeGroupJoinCodeMutationWritten(result.right));
}

function decodeGroupJoinCodeMutationWritten(value: JsonWireValue): GroupJoinCodeMutationWritten {
  const written = requireJsonWireRecord(value, 'Group join-code mutation result right');
  requireExactKeys(
    written,
    ['joinCode', 'expiresAtEpochMs', 'snapshot', 'event'],
    'Group join-code mutation result right',
  );
  requireString(written.joinCode, 'Group join-code mutation result joinCode');
  const expiresAtEpochMs = requireNonNegativeInteger(
    written.expiresAtEpochMs,
    'Group join-code mutation result expiresAtEpochMs',
  );
  validateAuthoritativeGroupSnapshot(written.snapshot);
  if (written.event !== null) {
    validateAuthoritativeGroupEvent(written.event, {
      applicationId: written.snapshot.group.applicationId,
      workspaceId: written.snapshot.group.workspaceId,
      groupId: written.snapshot.group.groupId,
    });
  }
  return {
    joinCode: written.joinCode,
    expiresAtEpochMs,
    snapshot: written.snapshot,
    event: written.event,
  };
}

function decodeGroupRef(value: JsonWireValue): GroupRef {
  const ref = requireJsonWireRecord(value, 'Group mutation receipt aggregateRef');
  requireExactKeys(
    ref,
    ['applicationId', 'workspaceId', 'groupId'],
    'Group mutation receipt aggregateRef',
  );
  requireString(ref.applicationId, 'Group mutation receipt applicationId');
  requireString(ref.workspaceId, 'Group mutation receipt workspaceId');
  requireString(ref.groupId, 'Group mutation receipt groupId');
  return {
    applicationId: ref.applicationId,
    workspaceId: ref.workspaceId,
    groupId: ref.groupId,
  };
}

function decodeCausalRevision(value: JsonWireValue): GroupStateCausalRevision {
  const revision = requireJsonWireRecord(value, 'Group mutation receipt causalRevision');
  requireExactKeys(
    revision,
    ['groupRevision', 'presenceRevision'],
    'Group mutation receipt causalRevision',
  );
  return {
    groupRevision: requireNonNegativeInteger(
      revision.groupRevision,
      'Group mutation receipt groupRevision',
    ),
    presenceRevision: requireNonNegativeInteger(
      revision.presenceRevision,
      'Group mutation receipt presenceRevision',
    ),
  };
}

function decodeStringArray(value: JsonWireValue, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((item) => {
    requireString(item, `${label} entry`);
    return item;
  });
}

function requireNullableString(value: JsonWireValue, label: string): string | null {
  if (value === null) return null;
  requireString(value, label);
  return value;
}

function requireNonNegativeInteger(value: JsonWireValue, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function requireNullableNonNegativeInteger(value: JsonWireValue, label: string): number | null {
  return value === null ? null : requireNonNegativeInteger(value, label);
}

function requireJsonWireRecord(value: JsonWireValue, label: string): JsonWireObject {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be an exact object`);
  }
  return Object.fromEntries(Object.entries(value));
}
