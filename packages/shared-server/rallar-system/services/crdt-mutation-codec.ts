import {
  hashRallarCrdtJson,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtTrustedAppendMetadata,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  decodeExactDocumentMetadata,
  decodeExactDocumentRef,
  decodeExactErasureAuditEvent,
  decodeExactErasureRequest,
  decodeExactIntegrityReport,
  decodeExactProjectionIds,
  decodeExactQuotaPolicy,
  decodeExactRetentionPolicy,
  decodeExactSnapshotEnvelope,
  decodeExactTrustedAppendMetadata,
  decodeExactValidationResult,
} from './crdt-mutation-value-codec.ts';
import {
  requireEpoch,
  requireExactKeys,
  requireNullableInteger,
  requireOneOf,
  requireRecord,
  requireString,
} from './exact-object-codec.ts';
import { decodeExactDebugBundle } from './crdt-debug-bundle-exact-codec.ts';
import { decodeExactUpdateEnvelope } from './crdt-update-exact-codec.ts';

export {
  decodeExactDocumentMetadata,
  decodeExactDocumentRef,
  decodeExactProjectionIds,
  decodeExactQuotaPolicy,
  decodeExactRetentionPolicy,
  decodeExactSnapshotEnvelope,
  decodeExactTrustedAppendMetadata,
  decodeExactValidationResult,
  decodeExactUpdateEnvelope,
};
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
      ? ['snapshotId', 'snapshot', 'reason']
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
  const document = decodeExactDocumentRef(command.document, 'CRDT command document');
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
    decodeExactSnapshotEnvelope(result.snapshot);
  } else if (operation === 'lifecycle' && result.metadata !== null) {
    decodeExactDocumentMetadata(result.metadata);
  } else if (operation === 'rebuild-projection' && result.integrity !== null) {
    decodeExactIntegrityReport(result.integrity);
  } else if (operation === 'erase') {
    if (result.request !== null) decodeExactErasureRequest(result.request);
    if (result.auditEvent !== null) decodeExactErasureAuditEvent(result.auditEvent);
    if (result.metadata !== null) decodeExactDocumentMetadata(result.metadata);
    if (result.redactedBundle !== null) decodeExactDebugBundle(result.redactedBundle);
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
    if (!rejected) {
      const update = append.update as RallarCrdtUpdateEnvelope;
      const trusted = append.append as RallarCrdtTrustedAppendMetadata;
      const document = append.document as RallarCrdtDocumentMetadata;
      if (
        result.documentKey !== document.documentKey ||
        result.documentKey !== toRallarCrdtDocumentKey(update.document) ||
        result.documentRevision !== document.documentRevision ||
        result.appendSequence !== trusted.appendSequence ||
        document.lastAppendSequence < trusted.appendSequence ||
        trusted.acceptedUpdateHash !== hashRallarCrdtUpdateEnvelope(update)
      ) throw new TypeError('CRDT append result document, revision, or sequence differs');
    } else {
      const update = append.update as RallarCrdtUpdateEnvelope | undefined;
      const document = append.document as RallarCrdtDocumentMetadata | undefined;
      if (
        (update && toRallarCrdtDocumentKey(update.document) !== result.documentKey) ||
        (document && (
          document.documentKey !== result.documentKey ||
          document.documentRevision !== result.documentRevision
        ))
      ) throw new TypeError('CRDT append rejection document or revision differs');
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
  if (!rejected && operation === 'lifecycle') {
    const metadata = result.metadata as RallarCrdtDocumentMetadata;
    if (
      metadata.documentKey !== result.documentKey ||
      metadata.documentRevision !== result.documentRevision ||
      metadata.lastAppendSequence !== result.appendSequence
    ) throw new TypeError('CRDT lifecycle result document, revision, or sequence differs');
  }
  if (!rejected && operation === 'compact') {
    const snapshot = result.snapshot as RallarCrdtSnapshotEnvelope;
    if (toRallarCrdtDocumentKey(snapshot.document) !== result.documentKey) {
      throw new TypeError('CRDT compact result document differs');
    }
  }
  if (!rejected && operation === 'rebuild-projection') {
    const integrity = result.integrity as Record<string, unknown>;
    if (integrity.documentKey !== result.documentKey) {
      throw new TypeError('CRDT rebuild result document differs');
    }
  }
  if (!rejected && operation === 'erase') {
    const request = result.request as Record<string, unknown>;
    const auditEvent = result.auditEvent as Record<string, unknown>;
    const metadata = result.metadata as RallarCrdtDocumentMetadata;
    const bundle = result.redactedBundle as Record<string, unknown> | null;
    const auditMetadata = auditEvent.metadata as Record<string, unknown>;
    const mode = request.mode;
    if (
      toRallarCrdtDocumentKey(request.document as RallarCrdtDocumentRef) !== result.documentKey ||
      auditEvent.documentKey !== result.documentKey ||
      auditEvent.atEpochMs !== request.requestedAtEpochMs ||
      auditEvent.principalId !== request.requestedBy ||
      auditEvent.reason !== request.reason ||
      auditMetadata.mode !== mode ||
      auditEvent.kind !== (mode === 'redact-payloads' ? 'redact' : 'erase') ||
      metadata.documentKey !== result.documentKey ||
      metadata.documentRevision !== result.documentRevision ||
      (bundle !== null && bundle.documentKey !== result.documentKey) ||
      (bundle !== null) !== (mode === 'redact-payloads')
    ) throw new TypeError('CRDT erase result document or revision differs');
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
    decodeExactTrustedAppendMetadata(append.append);
    decodeExactDocumentMetadata(append.document);
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
  if ('validation' in append) decodeExactValidationResult(append.validation);
  if ('document' in append) decodeExactDocumentMetadata(append.document);
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
    requireString(command.snapshotId, 'snapshotId');
    const snapshot = command.snapshot === null
      ? null
      : decodeExactSnapshotEnvelope(command.snapshot);
    if (
      snapshot !== null &&
      toRallarCrdtDocumentKey(snapshot.document) !== toRallarCrdtDocumentKey(document)
    ) {
      throw new TypeError('CRDT compact snapshot document differs from command document');
    }
    if (
      snapshot !== null && snapshot.snapshotId !== command.snapshotId
    ) {
      throw new TypeError('CRDT compact snapshot ID differs from command input');
    }
    requireString(command.reason, 'reason');
  } else if (operation === 'lifecycle') {
    requireOneOf(
      command.lifecycle,
      ['active', 'archived', 'destroyed', 'quarantined'] as const,
      'lifecycle',
    );
    const retention = decodeLifecycleAction(command.retentionAction, 'retention');
    if (retention.kind === 'set') decodeExactRetentionPolicy(retention.value);
    const quota = decodeLifecycleAction(command.quotaAction, 'quota');
    if (quota.kind === 'set') decodeExactQuotaPolicy(quota.value);
    const projections = decodeLifecycleAction(command.projectionIdsAction, 'projectionIds');
    if (projections.kind === 'set') decodeExactProjectionIds(projections.value);
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
  if (kind === 'set' && action.value === null) {
    throw new TypeError(`${label} action value is invalid`);
  }
  return action;
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
