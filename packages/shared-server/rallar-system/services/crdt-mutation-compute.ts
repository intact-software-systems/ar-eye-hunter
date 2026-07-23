import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtDebugBundle,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtAppendResult,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtSnapshotEnvelope,
  validateRallarCrdtUpdateEnvelope,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import { decodeCrdtMutationResult } from './crdt-mutation-codec.ts';
import type {
  CrdtAppendCommand,
  CrdtEraseMutationResult,
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationComputedRejected,
  CrdtMutationComputedReplay,
  CrdtMutationComputedWrite,
  CrdtMutationRead,
} from './crdt-mutation-contracts.ts';
import { toAppendOutbox, toCrdtAuditOutbox } from './crdt-mutation-outbox.ts';
import { appendRejectionReason, toAppendRejectionCode } from './crdt-append-rejection.ts';
import {
  toAcceptedAdminResultDetails,
  toCrdtMutationResult,
  toFallbackReplayAppend,
  toRejectedAdminResultDetails,
} from './crdt-mutation-result-builders.ts';

export function computeCrdtMutation(
  command: CrdtMutationCommand,
  read: CrdtMutationRead,
  serviceId: string,
): CrdtMutationComputed {
  if (!read.authorized) {
    return rejected(
      command,
      read,
      read.authorizationCode === 'allowed' ? 'authorization-denied' : read.authorizationCode,
      serviceId,
    );
  }
  if (!read.featureDecision.allowed) return rejected(command, read, 'feature-disabled', serviceId);
  if (command.operation === 'append') return computeAppend(command, read, serviceId);
  if (!read.document) return rejected(command, read, 'document-not-found', serviceId);
  if (command.operation === 'rebuild-projection') {
    const sourceIntegrity = verifyRallarCrdtDebugBundle(createRallarCrdtDebugBundle({
      exportedAtEpochMs: command.capturedAtEpochMs,
      reason: `rebuild-source:${command.projectionId}`,
      document: command.document,
      metadata: read.document,
      ...(read.snapshot ? { snapshot: read.snapshot } : {}),
      records: read.records,
    }));
    if (!sourceIntegrity.valid) return rejected(command, read, 'integrity-invalid', serviceId);
  }
  const next: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds: command.operation === 'rebuild-projection'
      ? [...new Set([...read.document.projectionIds, command.projectionId])]
      : command.operation === 'lifecycle'
      ? applyLifecycleAction(command.projectionIdsAction, read.document.projectionIds, [])
      : read.document.projectionIds,
    lifecycle: command.operation === 'lifecycle'
      ? command.lifecycle
      : command.operation === 'erase' && command.mode === 'destroy-document'
      ? 'destroyed'
      : read.document.lifecycle,
    archivedAtEpochMs: command.operation === 'lifecycle' && command.lifecycle === 'archived'
      ? command.capturedAtEpochMs
      : read.document.archivedAtEpochMs,
    destroyedAtEpochMs: command.operation === 'erase' && command.mode === 'destroy-document'
      ? command.capturedAtEpochMs
      : command.operation === 'lifecycle' && command.lifecycle === 'destroyed'
      ? command.capturedAtEpochMs
      : read.document.destroyedAtEpochMs,
    retention: command.operation === 'lifecycle'
      ? applyLifecycleAction(command.retentionAction, read.document.retention, null)
      : read.document.retention,
    quota: command.operation === 'lifecycle'
      ? applyLifecycleAction(command.quotaAction, read.document.quota, null)
      : read.document.quota,
    snapshotCount: command.operation === 'compact'
      ? read.document.snapshotCount + 1
      : read.document.snapshotCount,
  };
  const snapshot = command.operation === 'compact'
    ? command.snapshot ?? createRallarCrdtCompactedSnapshot({
      document: command.document,
      records: read.records,
      reason: command.reason,
      now: () => command.capturedAtEpochMs,
      createSnapshotId: () => command.snapshotId,
    })
    : null;
  if (
    snapshot && read.document.quota?.maxDocumentBytes !== undefined &&
    read.document.storedUpdateBytes + read.storedSnapshotBytes +
          byteLengthOfRallarCrdtJson(snapshot) > read.document.quota.maxDocumentBytes
  ) return rejected(command, read, 'quota-exceeded', serviceId);
  return writeComputed(
    command,
    read,
    next,
    snapshot,
    serviceId,
  );
}

function applyLifecycleAction<T>(
  action: Readonly<{ kind: 'preserve' | 'clear' | 'set'; value?: T }>,
  current: T,
  cleared: T,
): T {
  return action.kind === 'preserve'
    ? current
    : action.kind === 'clear'
    ? cleared
    : action.value as T;
}

function computeAppend(
  command: CrdtAppendCommand,
  read: CrdtMutationRead,
  serviceId: string,
): CrdtMutationComputed {
  const validation = validateRallarCrdtUpdateEnvelope(command.update);
  if (!validation.valid) return rejected(command, read, 'invalid-update', serviceId);
  const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
  if (read.existingUpdate) {
    const code = hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
      ? null
      : 'duplicate-hash-mismatch';
    return code === null
      ? replay(command, read, serviceId)
      : rejected(command, read, code, serviceId);
  }
  if (read.document && read.document.lifecycle !== 'active') {
    return rejected(command, read, `document-${read.document.lifecycle}`, serviceId);
  }
  const updateBytes = byteLengthOfRallarCrdtJson(command.update);
  const quota = read.document?.quota ?? read.featureDecision.policy?.quota;
  if (
    quota?.maxUpdateCount !== undefined &&
    (read.document?.updateCount ?? 0) >= quota.maxUpdateCount
  ) {
    return rejected(command, read, 'quota-exceeded', serviceId);
  }
  if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
    return rejected(command, read, 'update-too-large', serviceId);
  }
  if (
    quota?.maxDocumentBytes !== undefined &&
    (read.document?.storedUpdateBytes ?? 0) + read.storedSnapshotBytes + updateBytes >
      quota.maxDocumentBytes
  ) {
    return rejected(command, read, 'quota-exceeded', serviceId);
  }
  if (
    quota?.maxUpdatesPerMinutePerActor !== undefined &&
    read.actorUpdatesInWindow >= quota.maxUpdatesPerMinutePerActor
  ) {
    return rejected(command, read, 'rate-limited', serviceId);
  }
  const appendSequence = (read.document?.lastAppendSequence ?? 0) + 1;
  const append = {
    appendSequence,
    acceptedAtEpochMs: command.capturedAtEpochMs,
    actorId: command.actor.actorId,
    principalId: command.actor.principalId,
    sessionId: command.actor.sessionId,
    serverId: command.actor.serverId,
    authorizationScope: command.authorizationScope,
    acceptedUpdateHash: candidateHash,
  } as const;
  const document = nextAppendDocument(
    command,
    read,
    appendSequence,
    updateBytes,
  );
  const appendResult: RallarCrdtAppendResult = {
    status: 'accepted',
    update: command.update,
    append,
    document,
  };
  const response = toCrdtMutationResult(command, 'accepted', document, appendSequence, null, {
    appendResult,
  });
  return {
    outcome: 'write',
    operation: command.operation,
    commandId: command.commandId,
    commandHash: command.commandHash,
    documentKey: command.documentKey,
    expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
    expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
    expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
    document,
    update: command.update,
    append,
    snapshot: null,
    outboxEntries: toAppendOutbox(command, appendResult, serviceId, true),
    result: response,
  };
}

function nextAppendDocument(
  command: CrdtAppendCommand,
  read: CrdtMutationRead,
  appendSequence: number,
  updateBytes: number,
): RallarCrdtDocumentMetadata {
  const current = read.document;
  if (current) {
    return {
      ...current,
      documentRevision: current.documentRevision + 1,
      updatedAtEpochMs: command.capturedAtEpochMs,
      lastAppendSequence: appendSequence,
      updateCount: current.updateCount + 1,
      storedUpdateBytes: current.storedUpdateBytes + updateBytes,
    };
  }
  return {
    document: command.document,
    documentKey: command.documentKey,
    documentRevision: 1,
    lifecycle: 'active',
    createdAtEpochMs: command.capturedAtEpochMs,
    updatedAtEpochMs: command.capturedAtEpochMs,
    archivedAtEpochMs: null,
    destroyedAtEpochMs: null,
    lastAppendSequence: 1,
    updateCount: 1,
    snapshotCount: 0,
    storedUpdateBytes: updateBytes,
    retention: read.featureDecision.policy?.retention ?? null,
    quota: read.featureDecision.policy?.quota ?? null,
    projectionIds: [],
  };
}

function writeComputed(
  command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
  read: CrdtMutationRead,
  document: RallarCrdtDocumentMetadata,
  snapshot: RallarCrdtSnapshotEnvelope | null,
  serviceId: string,
): CrdtMutationComputedWrite {
  const resultDetails = toAcceptedAdminResultDetails(command, read, document, snapshot);
  const mutationResult = toCrdtMutationResult(
    command,
    'accepted',
    document,
    document.lastAppendSequence,
    null,
    resultDetails,
  );
  const auditEvent = command.operation === 'erase'
    ? (mutationResult as CrdtEraseMutationResult).auditEvent
    : null;
  return {
    outcome: 'write',
    operation: command.operation,
    commandId: command.commandId,
    commandHash: command.commandHash,
    documentKey: command.documentKey,
    expectedDocumentRevision: read.document!.documentRevision,
    expectedDocumentLifecycle: read.document!.lifecycle,
    expectedAppendSequence: read.document!.lastAppendSequence,
    document,
    update: null,
    append: null,
    snapshot,
    outboxEntries: auditEvent ? [toCrdtAuditOutbox(auditEvent, command, serviceId)] : [],
    result: mutationResult,
  };
}

function replay(
  command: CrdtAppendCommand,
  read: CrdtMutationRead,
  serviceId: string,
): CrdtMutationComputedReplay {
  const append = read.existingAppend ?? toFallbackReplayAppend(command, read.document);
  const appendResult: RallarCrdtAppendResult = read.document
    ? { status: 'duplicate', update: command.update, append, document: read.document }
    : rejectionResult(command, null, 'storage-failed');
  const response = toCrdtMutationResult(
    command,
    'replay',
    read.document,
    append.appendSequence,
    null,
    { appendResult },
  );
  return {
    outcome: 'replay',
    operation: command.operation,
    commandId: command.commandId,
    commandHash: command.commandHash,
    documentKey: command.documentKey,
    expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
    expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
    expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
    document: read.document,
    update: command.update,
    append,
    snapshot: null,
    outboxEntries: toAppendOutbox(command, appendResult, serviceId, false),
    result: response,
  };
}

function rejected(
  command: CrdtMutationCommand,
  read: CrdtMutationRead,
  code: string,
  serviceId: string,
): CrdtMutationComputedRejected {
  const appendResult = command.operation === 'append'
    ? rejectionResult(command, read.document, code)
    : undefined;
  const response = toCrdtMutationResult(
    command,
    'rejected',
    read.document,
    null,
    code,
    appendResult ? { appendResult } : toRejectedAdminResultDetails(
      command as Exclude<CrdtMutationCommand, CrdtAppendCommand>,
    ),
  );
  return {
    outcome: 'rejected',
    operation: command.operation,
    commandId: command.commandId,
    commandHash: command.commandHash,
    documentKey: command.documentKey,
    expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
    expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
    expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
    document: read.document,
    update: command.operation === 'append' ? command.update : null,
    append: null,
    snapshot: null,
    code,
    outboxEntries: command.operation === 'append' && read.authorized &&
        !code.startsWith('authorization-') &&
        !code.startsWith('authentication-')
      ? toAppendOutbox(command, appendResult!, serviceId, false)
      : [],
    result: response,
  };
}

function rejectionResult(
  command: CrdtAppendCommand,
  document: RallarCrdtDocumentMetadata | null,
  code: string,
): RallarCrdtAppendResult {
  const rejectionCode = toAppendRejectionCode(code);
  return {
    status: 'rejected',
    update: command.update,
    code: rejectionCode,
    reason: appendRejectionReason(rejectionCode),
    retryable: rejectionCode === 'storage-failed' || rejectionCode === 'rate-limited',
    ...(document ? { document } : {}),
  };
}

export function validateCrdtMutation(
  command: CrdtMutationCommand,
  read: CrdtMutationRead,
  computed: CrdtMutationComputed,
): void {
  if (
    computed.commandId !== command.commandId ||
    computed.commandHash !== command.commandHash ||
    computed.documentKey !== command.documentKey
  ) throw new TypeError('CRDT computed identity differs from command');
  if (
    computed.outcome === 'write' &&
    read.document &&
    computed.expectedDocumentRevision !== read.document.documentRevision
  ) throw new TypeError('CRDT computed predecessor differs from read document');
  decodeCrdtMutationResult(computed.result);
}
