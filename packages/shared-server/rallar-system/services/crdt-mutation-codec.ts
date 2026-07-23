import {
  hashRallarCrdtJson,
  type RallarCrdtDocumentRef,
  toRallarCrdtDocumentKey,
} from '@shared/crdt/mod.ts';
import {
  decodeExactDocumentMetadata,
  decodeExactDocumentRef,
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
  requireOneOf,
  requireRecord,
  requireString,
} from './exact-object-codec.ts';
import { decodeExactUpdateEnvelope } from './crdt-update-exact-codec.ts';
import type {
  CrdtMutationCommand,
  CreateCrdtMutationCommandInput,
} from './crdt-mutation-contracts.ts';
import {
  requireCrdtCanonicalSnapshotReason,
  toCrdtCanonicalSnapshotEnvelope,
} from './crdt-compact-snapshot.ts';

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
export { decodeCrdtMutationResult } from './crdt-mutation-result-codec.ts';

export async function createCrdtMutationCommand(
  input: CreateCrdtMutationCommandInput,
): Promise<CrdtMutationCommand> {
  const canonicalInput = input.operation === 'compact'
    ? toCanonicalCompactCommandInput(input)
    : input;
  const stable = {
    ...canonicalInput,
    deliveryId: canonicalInput.deliveryId ?? canonicalInput.commandId,
    documentKey: toRallarCrdtDocumentKey(canonicalInput.document),
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
  requireString(command.deliveryId, 'deliveryId');
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
    requireCrdtCanonicalSnapshotReason(command.reason);
    if (snapshot !== null && snapshot.metadata.reason !== command.reason) {
      throw new TypeError('CRDT compact snapshot reason differs from command reason');
    }
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

function toCanonicalCompactCommandInput(
  input: Extract<CreateCrdtMutationCommandInput, { operation: 'compact' }>,
): CreateCrdtMutationCommandInput {
  requireString(input.reason, 'reason');
  return {
    ...input,
    snapshot: input.snapshot === null
      ? null
      : toCrdtCanonicalSnapshotEnvelope(input.snapshot, input.reason),
  };
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
  'deliveryId',
  'commandHash',
  'actor',
  'capturedAtEpochMs',
  'expireAtEpochMs',
  'document',
  'documentKey',
  'responseAudience',
];
