import {
  byteLengthOfRallarCrdtJson,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtAppendRejected,
  type RallarCrdtAppendResult,
  type RallarCrdtDocumentMetadata,
  validateRallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type {
  CrdtAppendCommand,
  CrdtCanonicalSnapshotEnvelope,
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationComputedRejected,
  CrdtMutationComputedReplay,
  CrdtMutationComputedWrite,
  CrdtMutationAttemptFacts,
  CrdtMutationRead,
} from './crdt-mutation-contracts.ts';
import { toAppendOutbox, toCrdtAuditOutbox } from './create-crdt-mutation-outbox.ts';
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
} from './create-crdt-mutation-result.ts';
import {
  computeCrdtErase,
  computeCrdtLifecycleUpdate,
  computeCrdtProjectionRebuild,
  computeCrdtSnapshotCompact,
} from './compute-crdt-administration.ts';

export interface ComputeCrdtMutationInput extends CrdtMutationAttemptFacts {
  readonly serviceId: string;
}

interface CrdtMutationRejectedInput {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly code: string;
  readonly serviceId: string;
}

interface CrdtMutationComputedBaseInput<TDocument extends RallarCrdtDocumentMetadata | null> {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly document: TDocument;
  readonly update: CrdtAppendCommand['update'] | null;
  readonly append: CrdtMutationComputed['append'];
  readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
  readonly outboxEntries: CrdtMutationComputed['outboxEntries'];
  readonly result: CrdtMutationComputed['result'];
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

export function computeCrdtMutation(input: ComputeCrdtMutationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
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
  switch (command.operation) {
    case 'append':
      return computeCrdtAppend(input);
    case 'rebuild-projection':
      return computeCrdtProjectionRebuild(input);
    case 'compact':
      return computeCrdtSnapshotCompact(input);
    case 'lifecycle':
      return computeCrdtLifecycleUpdate(input);
    case 'erase':
      return computeCrdtErase(input);
  }
}

function computeCrdtAppend(input: ComputeCrdtMutationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'append') {
    throw new TypeError('CRDT append computation requires an append command');
  }
  const validation = validateRallarCrdtUpdateEnvelope(command.update);
  if (!validation.valid) {
    return rejected({ command, read, code: 'invalid-update', serviceId });
  }
  const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
  if (read.existingUpdate) {
    const code =
      hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
        ? null
        : 'duplicate-hash-mismatch';
    return code === null
      ? replay({ command, read, serviceId })
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
  const result = toCrdtMutationResult({
    command,
    status: 'accepted',
    document,
    appendSequence,
    code: null,
    details: { appendResult },
  });
  return {
    ...createCrdtMutationComputedBase({
      command,
      read,
      document,
      update: command.update,
      append,
      snapshot: null,
      outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: true }),
      result,
    }),
    outcome: 'write',
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

export function writeComputed(input: CrdtMutationWriteComputedInput): CrdtMutationComputedWrite {
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
    mutationResult.operation === 'erase' && mutationResult.status === 'accepted'
      ? mutationResult.auditEvent
      : null;
  return {
    ...createCrdtMutationComputedBase({
      command,
      read,
      document,
      update: null,
      append: null,
      snapshot,
      outboxEntries: auditEvent ? [toCrdtAuditOutbox(auditEvent, command, serviceId)] : [],
      result: mutationResult,
    }),
    outcome: 'write',
  };
}

interface ReplayCrdtMutationInput {
  readonly command: CrdtAppendCommand;
  readonly read: CrdtMutationRead;
  readonly serviceId: string;
}

function replay(input: ReplayCrdtMutationInput): CrdtMutationComputedReplay {
  const { command, read, serviceId } = input;
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
    ...createCrdtMutationComputedBase({
      command,
      read,
      document: read.document,
      update: command.update,
      append,
      snapshot: null,
      outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: false }),
      result: response,
    }),
    outcome: 'replay',
  };
}

export function rejected(input: CrdtMutationRejectedInput): CrdtMutationComputedRejected {
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
  const outboxEntries =
    command.operation === 'append' &&
    appendResult !== undefined &&
    read.authorized &&
    !code.startsWith('authorization-') &&
    !code.startsWith('authentication-')
      ? toAppendOutbox({ command, response: appendResult, serviceId, fanout: false })
      : [];
  return {
    ...createCrdtMutationComputedBase({
      command,
      read,
      document: read.document,
      update: command.operation === 'append' ? command.update : null,
      append: null,
      snapshot: null,
      outboxEntries,
      result: response,
    }),
    outcome: 'rejected',
    code,
  };
}

function createCrdtMutationComputedBase<TDocument extends RallarCrdtDocumentMetadata | null>(
  input: CrdtMutationComputedBaseInput<TDocument>,
): {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly operation: CrdtMutationCommand['operation'];
  readonly commandId: string;
  readonly commandHash: string;
  readonly documentKey: string;
  readonly expectedDocumentRevision: number | 'absent';
  readonly expectedDocumentLifecycle: CrdtMutationComputed['expectedDocumentLifecycle'];
  readonly expectedAppendSequence: number | 'absent';
  readonly document: TDocument;
  readonly update: CrdtAppendCommand['update'] | null;
  readonly append: CrdtMutationComputed['append'];
  readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
  readonly outboxEntries: CrdtMutationComputed['outboxEntries'];
  readonly result: CrdtMutationComputed['result'];
} {
  const { command, read, document, update, append, snapshot, outboxEntries, result } = input;
  return {
    command,
    read,
    operation: command.operation,
    commandId: command.commandId,
    commandHash: command.commandHash,
    documentKey: command.documentKey,
    expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
    expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
    expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
    document,
    update,
    append,
    snapshot,
    outboxEntries,
    result,
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
