import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtDebugBundle,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtAppendRejected,
  type RallarCrdtAppendResult,
  type RallarCrdtDocumentMetadata,
  validateRallarCrdtUpdateEnvelope,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import { toCrdtCanonicalSnapshotEnvelope } from './crdt-compact-snapshot.ts';
import type {
  CrdtAppendCommand,
  CrdtCanonicalSnapshotEnvelope,
  CrdtEraseMutationResult,
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationComputedRejected,
  CrdtMutationComputedReplay,
  CrdtMutationComputedWrite,
  CrdtMutationRead,
} from '../crdt/mutation/crdt-mutation-contracts.ts';
import { toAppendOutbox, toCrdtAuditOutbox } from './crdt-mutation-outbox.ts';
import {
  appendRejectionReason,
  isAppendRejectionRetryable,
  toAppendRejectionCode,
} from './crdt-append-rejection.ts';
import {
  toAcceptedAdminResultDetails,
  toCrdtMutationResult,
  toFallbackReplayAppend,
  toRejectedAdminResultDetails,
} from './crdt-mutation-result-builders.ts';

interface CrdtMutationRejectedInput {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly code: string;
  readonly serviceId: string;
}

interface CrdtMutationWriteComputedInput {
  readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
  readonly read: CrdtMutationRead;
  readonly document: RallarCrdtDocumentMetadata;
  readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
  readonly serviceId: string;
}

interface NextAppendDocumentInput {
  readonly command: CrdtAppendCommand;
  readonly read: CrdtMutationRead;
  readonly appendSequence: number;
  readonly updateBytes: number;
}

export function computeCrdtMutation(
  command: CrdtMutationCommand,
  read: CrdtMutationRead,
  serviceId: string,
): CrdtMutationComputed {
  if (!read.authorized) {
    return rejected({
      command,
      read,
      code: read.authorizationCode === 'allowed' ? 'authorization-denied' : read.authorizationCode,
      serviceId,
    });
  }
  if (!read.featureDecision.allowed) {
    return rejected({ command, read, code: 'feature-disabled', serviceId });
  }
  if (command.operation === 'append') return computeAppend(command, read, serviceId);
  if (!read.document) return rejected({ command, read, code: 'document-not-found', serviceId });
  if (command.operation === 'rebuild-projection') {
    const sourceIntegrity = verifyRallarCrdtDebugBundle(
      createRallarCrdtDebugBundle({
        exportedAtEpochMs: command.capturedAtEpochMs,
        reason: `rebuild-source:${command.projectionId}`,
        document: command.document,
        metadata: read.document,
        ...(read.snapshot ? { snapshot: read.snapshot } : {}),
        records: read.records,
      }),
    );
    if (!sourceIntegrity.valid) {
      return rejected({ command, read, code: 'integrity-invalid', serviceId });
    }
  }
  const next: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds:
      command.operation === 'rebuild-projection'
        ? [...new Set([...read.document.projectionIds, command.projectionId])]
        : command.operation === 'lifecycle'
          ? applyLifecycleAction(command.projectionIdsAction, read.document.projectionIds, [])
          : read.document.projectionIds,
    lifecycle:
      command.operation === 'lifecycle'
        ? command.lifecycle
        : command.operation === 'erase' && command.mode === 'destroy-document'
          ? 'destroyed'
          : read.document.lifecycle,
    archivedAtEpochMs:
      command.operation === 'lifecycle' && command.lifecycle === 'archived'
        ? command.capturedAtEpochMs
        : read.document.archivedAtEpochMs,
    destroyedAtEpochMs:
      command.operation === 'erase' && command.mode === 'destroy-document'
        ? command.capturedAtEpochMs
        : command.operation === 'lifecycle' && command.lifecycle === 'destroyed'
          ? command.capturedAtEpochMs
          : read.document.destroyedAtEpochMs,
    retention:
      command.operation === 'lifecycle'
        ? applyLifecycleAction(command.retentionAction, read.document.retention, null)
        : read.document.retention,
    quota:
      command.operation === 'lifecycle'
        ? applyLifecycleAction(command.quotaAction, read.document.quota, null)
        : read.document.quota,
    snapshotCount:
      command.operation === 'compact'
        ? read.document.snapshotCount + 1
        : read.document.snapshotCount,
  };
  const snapshot: CrdtCanonicalSnapshotEnvelope | null =
    command.operation === 'compact'
      ? (command.snapshot ??
        toCrdtCanonicalSnapshotEnvelope(
          createRallarCrdtCompactedSnapshot({
            document: command.document,
            records: read.records,
            reason: command.reason,
            now: () => command.capturedAtEpochMs,
            createSnapshotId: () => command.snapshotId,
          }),
          command.reason,
        ))
      : null;
  if (
    snapshot &&
    read.document.quota?.maxDocumentBytes !== undefined &&
    read.document.storedUpdateBytes +
      read.storedSnapshotBytes +
      byteLengthOfRallarCrdtJson(snapshot) >
      read.document.quota.maxDocumentBytes
  )
    return rejected({ command, read, code: 'quota-exceeded', serviceId });
  return writeComputed({ command, read, document: next, snapshot, serviceId });
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
      : (action.value as T);
}

function computeAppend(
  command: CrdtAppendCommand,
  read: CrdtMutationRead,
  serviceId: string,
): CrdtMutationComputed {
  const validation = validateRallarCrdtUpdateEnvelope(command.update);
  if (!validation.valid) return rejected({ command, read, code: 'invalid-update', serviceId });
  const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
  if (read.existingUpdate) {
    const code =
      hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
        ? null
        : 'duplicate-hash-mismatch';
    return code === null
      ? replay(command, read, serviceId)
      : rejected({ command, read, code, serviceId });
  }
  if (read.document && read.document.lifecycle !== 'active') {
    return rejected({
      command,
      read,
      code: `document-${read.document.lifecycle}`,
      serviceId,
    });
  }
  const updateBytes = byteLengthOfRallarCrdtJson(command.update);
  const quota = read.document?.quota ?? read.featureDecision.policy?.quota;
  if (
    quota?.maxUpdateCount !== undefined &&
    (read.document?.updateCount ?? 0) >= quota.maxUpdateCount
  ) {
    return rejected({ command, read, code: 'quota-exceeded', serviceId });
  }
  if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
    return rejected({ command, read, code: 'update-too-large', serviceId });
  }
  if (
    quota?.maxDocumentBytes !== undefined &&
    (read.document?.storedUpdateBytes ?? 0) + read.storedSnapshotBytes + updateBytes >
      quota.maxDocumentBytes
  ) {
    return rejected({ command, read, code: 'quota-exceeded', serviceId });
  }
  if (
    quota?.maxUpdatesPerMinutePerActor !== undefined &&
    read.actorUpdatesInWindow >= quota.maxUpdatesPerMinutePerActor
  ) {
    return rejected({ command, read, code: 'rate-limited', serviceId });
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
  const document = nextAppendDocument({ command, read, appendSequence, updateBytes });
  const appendResult: RallarCrdtAppendResult = {
    status: 'accepted',
    update: command.update,
    append,
    document,
  };
  const response = toCrdtMutationResult({
    command,
    status: 'accepted',
    document,
    appendSequence,
    code: null,
    details: { appendResult },
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
    outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: true }),
    result: response,
  };
}

function nextAppendDocument(input: NextAppendDocumentInput): RallarCrdtDocumentMetadata {
  const { command, read, appendSequence, updateBytes } = input;
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

function writeComputed(input: CrdtMutationWriteComputedInput): CrdtMutationComputedWrite {
  const { command, read, document, snapshot, serviceId } = input;
  const resultDetails = toAcceptedAdminResultDetails({ command, read, document, snapshot });
  const mutationResult = toCrdtMutationResult({
    command,
    status: 'accepted',
    document,
    appendSequence: document.lastAppendSequence,
    code: null,
    details: resultDetails,
  });
  const auditEvent =
    command.operation === 'erase' ? (mutationResult as CrdtEraseMutationResult).auditEvent : null;
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
  const response = toCrdtMutationResult({
    command,
    status: 'replay',
    document: read.document,
    appendSequence: append.appendSequence,
    code: null,
    details: { appendResult },
  });
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
    outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: false }),
    result: response,
  };
}

function rejected(input: CrdtMutationRejectedInput): CrdtMutationComputedRejected {
  const { command, read, code, serviceId } = input;
  const appendResult =
    command.operation === 'append' ? rejectionResult(command, read.document, code) : undefined;
  const response = toCrdtMutationResult({
    command,
    status: 'rejected',
    document: read.document,
    appendSequence: null,
    code,
    details: appendResult
      ? { appendResult }
      : toRejectedAdminResultDetails(command as Exclude<CrdtMutationCommand, CrdtAppendCommand>),
  });
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
    outboxEntries:
      command.operation === 'append' &&
      read.authorized &&
      !code.startsWith('authorization-') &&
      !code.startsWith('authentication-')
        ? toAppendOutbox({ command, response: appendResult!, serviceId, fanout: false })
        : [],
    result: response,
  };
}

function rejectionResult(
  command: CrdtAppendCommand,
  document: RallarCrdtDocumentMetadata | null,
  code: string,
): RallarCrdtAppendRejected {
  const rejectionCode = toAppendRejectionCode(code);
  const rejection = {
    status: 'rejected',
    update: command.update,
    code: rejectionCode,
    reason: appendRejectionReason(rejectionCode),
    ...(document ? { document } : {}),
  } as const;
  return isAppendRejectionRetryable(rejectionCode)
    ? { ...rejection, code: rejectionCode, retryable: true }
    : { ...rejection, code: rejectionCode, retryable: false };
}
