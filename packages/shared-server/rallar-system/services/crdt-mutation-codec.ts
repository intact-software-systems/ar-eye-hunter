import {
  hashRallarCrdtJson,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
  validateRallarCrdtSnapshotEnvelope,
  validateRallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type {
  CrdtMutationCommand,
  CrdtMutationResult,
  CreateCrdtMutationCommandInput,
} from './crdt-mutation-contracts.ts';

export async function createCrdtMutationCommand(
  input: CreateCrdtMutationCommandInput,
): Promise<CrdtMutationCommand> {
  const stable = {
    ...input,
    documentKey: toRallarCrdtDocumentKey(input.document),
    version: 1 as const,
  };
  return decodeCrdtMutationCommand({
    ...stable,
    commandHash: hashRallarCrdtJson(stable),
  });
}

export function decodeCrdtMutationCommand(value: unknown): CrdtMutationCommand {
  const command = requireRecord(value, 'CRDT mutation command');
  const operation = requireOneOf(
    command.operation,
    [
      'append',
      'rebuild-projection',
      'compact',
      'lifecycle',
      'erase',
    ] as const,
    'CRDT mutation operation',
  );
  const allowed = commonCommandKeys.concat(
    operation === 'append'
      ? ['update', 'authorizationScope']
      : operation === 'rebuild-projection'
      ? ['projectionId']
      : operation === 'compact'
      ? ['snapshot', 'reason']
      : operation === 'lifecycle'
      ? ['lifecycle', 'retentionAction', 'quotaAction', 'projectionIdsAction']
      : ['mode', 'reason'],
  );
  requireExactKeys(command, allowed, 'CRDT mutation command');
  if (command.version !== 1) throw new TypeError('CRDT mutation version is invalid');
  requireString(command.commandId, 'commandId');
  requireString(command.commandHash, 'commandHash');
  requireEpoch(command.capturedAtEpochMs, 'capturedAtEpochMs');
  requireEpoch(command.expireAtEpochMs, 'expireAtEpochMs');
  if ((command.expireAtEpochMs as number) <= (command.capturedAtEpochMs as number)) {
    throw new TypeError('CRDT mutation expiry must follow capture time');
  }
  const actor = requireRecord(command.actor, 'CRDT mutation actor');
  requireExactKeys(actor, ['actorId', 'principalId', 'sessionId', 'serverId'], 'actor');
  Object.values(actor).forEach((field) => requireString(field, 'actor field'));
  const audience = requireRecord(command.responseAudience, 'CRDT response audience');
  requireExactKeys(
    audience,
    ['kind', 'senderSessionId', 'topicId', 'contextId'],
    'responseAudience',
  );
  requireOneOf(audience.kind, ['room', 'principal', 'app', 'admin'] as const, 'audience kind');
  requireString(audience.senderSessionId, 'senderSessionId');
  requireString(audience.topicId, 'topicId');
  requireString(audience.contextId, 'contextId');
  const document = command.document as RallarCrdtDocumentRef;
  if (toRallarCrdtDocumentKey(document) !== command.documentKey) {
    throw new TypeError('CRDT command document key differs from document');
  }
  validateOperationFields(operation, command, document);
  const { commandHash: _hash, ...stable } = command;
  if (hashRallarCrdtJson(stable) !== command.commandHash) {
    throw new TypeError('CRDT mutation command hash differs from canonical command');
  }
  return command as unknown as CrdtMutationCommand;
}

export function decodeCrdtMutationResult(value: unknown): CrdtMutationResult {
  const result = requireRecord(value, 'CRDT mutation result');
  const operation = requireOneOf(
    result.operation,
    [
      'append',
      'rebuild-projection',
      'compact',
      'lifecycle',
      'erase',
    ] as const,
    'result operation',
  );
  const operationKeys = operation === 'append'
    ? ['appendResult']
    : operation === 'compact'
    ? ['snapshot']
    : operation === 'lifecycle'
    ? ['metadata']
    : operation === 'rebuild-projection'
    ? ['integrity']
    : ['request', 'auditEvent', 'metadata', 'redactedBundle'];
  requireExactKeys(result, [
    'version',
    'operation',
    'status',
    'commandId',
    'documentKey',
    'documentRevision',
    'appendSequence',
    'code',
    ...operationKeys,
  ], 'CRDT mutation result');
  if (result.version !== 1) throw new TypeError('CRDT mutation result version is invalid');
  requireOneOf(result.status, ['accepted', 'replay', 'rejected'] as const, 'result status');
  requireString(result.commandId, 'result commandId');
  requireString(result.documentKey, 'result documentKey');
  requireNullableInteger(result.documentRevision, 'result documentRevision');
  requireNullableInteger(result.appendSequence, 'result appendSequence');
  if (result.code !== null) requireString(result.code, 'result code');
  if (operation === 'append') decodeAppendResult(result.appendResult);
  else if (operation === 'compact' && result.snapshot !== null) {
    if (!validateRallarCrdtSnapshotEnvelope(result.snapshot).valid) {
      throw new TypeError('CRDT compact result snapshot is invalid');
    }
  } else if (operation === 'lifecycle' && result.metadata !== null) {
    requireRecord(result.metadata, 'CRDT lifecycle result metadata');
  } else if (operation === 'rebuild-projection' && result.integrity !== null) {
    requireRecord(result.integrity, 'CRDT rebuild result integrity');
  } else if (operation === 'erase') {
    for (const field of ['request', 'auditEvent', 'metadata', 'redactedBundle']) {
      if (result[field] !== null) requireRecord(result[field], `CRDT erase result ${field}`);
    }
  }
  validateResultConsistency(result, operation);
  return result as unknown as CrdtMutationResult;
}

function validateResultConsistency(
  result: Record<string, unknown>,
  operation: CrdtMutationResult['operation'],
): void {
  const rejected = result.status === 'rejected';
  if (rejected !== (result.code !== null) || (rejected && result.appendSequence !== null)) {
    throw new TypeError('CRDT mutation result status and code are inconsistent');
  }
  if (operation === 'append') {
    const append = result.appendResult as Record<string, unknown>;
    const expected = result.status === 'accepted'
      ? 'accepted'
      : result.status === 'replay'
      ? 'duplicate'
      : 'rejected';
    if (append.status !== expected) {
      throw new TypeError('CRDT append result status is inconsistent');
    }
    return;
  }
  const nested = operation === 'compact'
    ? result.snapshot
    : operation === 'lifecycle'
    ? result.metadata
    : operation === 'rebuild-projection'
    ? result.integrity
    : result.request;
  if (rejected !== (nested === null)) {
    throw new TypeError(`CRDT ${operation} result status and payload are inconsistent`);
  }
}

function decodeAppendResult(value: unknown): void {
  const append = requireRecord(value, 'CRDT append result');
  const status = requireOneOf(
    append.status,
    ['accepted', 'duplicate', 'rejected'] as const,
    'append status',
  );
  if (status === 'accepted' || status === 'duplicate') {
    requireExactKeys(append, ['status', 'update', 'append', 'document'], 'CRDT append result');
    decodeExactUpdateEnvelope(append.update);
    requireRecord(append.append, 'CRDT append metadata');
    requireRecord(append.document, 'CRDT append document metadata');
    return;
  }
  const keys = [
    'status',
    'code',
    'reason',
    'retryable',
    ...('update' in append ? ['update'] : []),
    ...('validation' in append ? ['validation'] : []),
    ...('document' in append ? ['document'] : []),
  ];
  requireExactKeys(append, keys, 'CRDT append rejection');
  requireString(append.code, 'append rejection code');
  requireString(append.reason, 'append rejection reason');
  if (typeof append.retryable !== 'boolean') throw new TypeError('append retryable is invalid');
  if ('update' in append) decodeExactUpdateEnvelope(append.update);
}

function validateOperationFields(
  operation: CrdtMutationCommand['operation'],
  command: Record<string, unknown>,
  document: RallarCrdtDocumentRef,
): void {
  if (operation === 'append') {
    const update = decodeExactUpdateEnvelope(command.update);
    if (toRallarCrdtDocumentKey(update.document) !== toRallarCrdtDocumentKey(document)) {
      throw new TypeError('CRDT update document differs');
    }
    requireOneOf(
      command.authorizationScope,
      ['room', 'principal', 'app', 'custom'] as const,
      'authorizationScope',
    );
  } else if (operation === 'rebuild-projection') {
    requireString(command.projectionId, 'projectionId');
  } else if (operation === 'compact') {
    if (
      command.snapshot !== null &&
      !validateRallarCrdtSnapshotEnvelope(command.snapshot as RallarCrdtSnapshotEnvelope).valid
    ) {
      throw new TypeError('CRDT compact snapshot is invalid');
    }
    if (
      command.snapshot !== null &&
      toRallarCrdtDocumentKey((command.snapshot as RallarCrdtSnapshotEnvelope).document) !==
        toRallarCrdtDocumentKey(document)
    ) {
      throw new TypeError('CRDT compact snapshot document differs from command document');
    }
    requireString(command.reason, 'reason');
  } else if (operation === 'lifecycle') {
    requireOneOf(
      command.lifecycle,
      ['active', 'archived', 'destroyed', 'quarantined'] as const,
      'lifecycle',
    );
    decodeLifecycleAction(command.retentionAction, 'retention');
    decodeLifecycleAction(command.quotaAction, 'quota');
    const projections = decodeLifecycleAction(command.projectionIdsAction, 'projectionIds');
    if (
      projections.kind === 'set' &&
      (!Array.isArray(projections.value) || projections.value.some((id) => typeof id !== 'string'))
    ) throw new TypeError('projectionIds are invalid');
  } else {
    requireOneOf(command.mode, ['destroy-document', 'redact-payloads'] as const, 'erase mode');
    requireString(command.reason, 'reason');
  }
}

function decodeLifecycleAction(value: unknown, label: string): Record<string, unknown> {
  const action = requireRecord(value, `${label} action`);
  const kind = requireOneOf(
    action.kind,
    ['preserve', 'clear', 'set'] as const,
    `${label} action kind`,
  );
  requireExactKeys(action, kind === 'set' ? ['kind', 'value'] : ['kind'], `${label} action`);
  if (kind === 'set' && (action.value === null || typeof action.value !== 'object')) {
    throw new TypeError(`${label} action value is invalid`);
  }
  return action;
}

export function decodeExactUpdateEnvelope(value: unknown): RallarCrdtUpdateEnvelope {
  const update = requireRecord(value, 'CRDT update envelope');
  const allowed = [
    'protocolVersion',
    'document',
    'updateId',
    'replicaId',
    'lamport',
    'parents',
    'schemaVersion',
    'operationVersion',
    'createdAtEpochMs',
    'payload',
    ...('actorId' in update ? ['actorId'] : []),
    ...('sessionId' in update ? ['sessionId'] : []),
    ...('causalFrontier' in update ? ['causalFrontier'] : []),
    ...('hash' in update ? ['hash'] : []),
  ];
  requireExactKeys(update, allowed, 'CRDT update envelope');
  const document = requireRecord(update.document, 'CRDT update document');
  const documentKeys = [
    'applicationId',
    'scope',
    'documentType',
    'documentId',
    ...('workspaceId' in document ? ['workspaceId'] : []),
    ...('roomRef' in document ? ['roomRef'] : []),
    ...('principalId' in document ? ['principalId'] : []),
    ...('customScope' in document ? ['customScope'] : []),
  ];
  requireExactKeys(document, documentKeys, 'CRDT update document');
  if ('roomRef' in document) {
    const roomRef = requireRecord(document.roomRef, 'CRDT update roomRef');
    requireExactKeys(roomRef, ['applicationId', 'workspaceId', 'groupId'], 'CRDT update roomRef');
  }
  const validation = validateRallarCrdtUpdateEnvelope(update);
  if (!validation.valid) throw new TypeError('CRDT update envelope is invalid');
  return update as unknown as RallarCrdtUpdateEnvelope;
}

const commonCommandKeys = [
  'version',
  'operation',
  'commandId',
  'commandHash',
  'actor',
  'capturedAtEpochMs',
  'expireAtEpochMs',
  'document',
  'documentKey',
  'responseAudience',
];

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be an exact object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireEpoch(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function requireNullableInteger(value: unknown, label: string): void {
  if (value !== null) requireEpoch(value, label);
}

function requireOneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}
