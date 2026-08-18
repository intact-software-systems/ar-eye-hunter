import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtDebugBundle,
  type RallarCrdtDocumentMetadata,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type {
  CrdtAppendCommand,
  CrdtCanonicalSnapshotEnvelope,
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationComputedRejected,
  CrdtMutationComputedWrite,
  CrdtMutationRead,
} from './crdt-mutation-contracts.ts';
import { toCrdtAuditOutbox } from './create-crdt-mutation-outbox.ts';
import {
  toAcceptedAdminResultDetails,
  toCrdtMutationResult,
  toRejectedAdminResultDetails,
} from './create-crdt-mutation-result.ts';
import { toCrdtCanonicalSnapshotEnvelope } from './to-crdt-canonical-snapshot.ts';

export interface ComputeCrdtAdministrationInput {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly serviceId: string;
}

export function computeCrdtProjectionRebuild(
  input: ComputeCrdtAdministrationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'rebuild-projection') {
    throw new TypeError('CRDT projection rebuild computation requires a rebuild command');
  }
  if (!read.document) {
    return rejectedAdmin({ command, read, code: 'document-not-found', serviceId });
  }
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
    return rejectedAdmin({ command, read, code: 'integrity-invalid', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds: [...new Set([...read.document.projectionIds, command.projectionId])],
  };
  return writeAdmin({ command, read, document, snapshot: null, serviceId });
}

export function computeCrdtSnapshotCompact(
  input: ComputeCrdtAdministrationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'compact') {
    throw new TypeError('CRDT snapshot compaction requires a compact command');
  }
  if (!read.document) {
    return rejectedAdmin({ command, read, code: 'document-not-found', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    snapshotCount: read.document.snapshotCount + 1,
  };
  const snapshot =
    command.snapshot ??
    toCrdtCanonicalSnapshotEnvelope(
      createRallarCrdtCompactedSnapshot({
        document: command.document,
        records: read.records,
        reason: command.reason,
        now: () => command.capturedAtEpochMs,
        createSnapshotId: () => command.snapshotId,
      }),
      command.reason,
    );
  if (
    read.document.quota?.maxDocumentBytes !== undefined &&
    read.document.storedUpdateBytes +
      read.storedSnapshotBytes +
      byteLengthOfRallarCrdtJson(snapshot) >
      read.document.quota.maxDocumentBytes
  ) {
    return rejectedAdmin({ command, read, code: 'quota-exceeded', serviceId });
  }
  return writeAdmin({ command, read, document, snapshot, serviceId });
}

export function computeCrdtLifecycleUpdate(
  input: ComputeCrdtAdministrationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'lifecycle') {
    throw new TypeError('CRDT lifecycle computation requires a lifecycle command');
  }
  if (!read.document) {
    return rejectedAdmin({ command, read, code: 'document-not-found', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds: applyLifecycleAction(
      command.projectionIdsAction,
      read.document.projectionIds,
      [],
    ),
    lifecycle: command.lifecycle,
    archivedAtEpochMs:
      command.lifecycle === 'archived'
        ? command.capturedAtEpochMs
        : read.document.archivedAtEpochMs,
    destroyedAtEpochMs:
      command.lifecycle === 'destroyed'
        ? command.capturedAtEpochMs
        : read.document.destroyedAtEpochMs,
    retention: applyLifecycleAction(command.retentionAction, read.document.retention, null),
    quota: applyLifecycleAction(command.quotaAction, read.document.quota, null),
  };
  return writeAdmin({ command, read, document, snapshot: null, serviceId });
}

export function computeCrdtErase(input: ComputeCrdtAdministrationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'erase') {
    throw new TypeError('CRDT erase computation requires an erase command');
  }
  if (!read.document) {
    return rejectedAdmin({ command, read, code: 'document-not-found', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    lifecycle: command.mode === 'destroy-document' ? 'destroyed' : read.document.lifecycle,
    destroyedAtEpochMs:
      command.mode === 'destroy-document'
        ? command.capturedAtEpochMs
        : read.document.destroyedAtEpochMs,
  };
  return writeAdmin({ command, read, document, snapshot: null, serviceId });
}

interface CrdtLifecycleAction<T> {
  readonly kind: 'preserve' | 'clear' | 'set';
  readonly value?: T;
}

function applyLifecycleAction<T>(action: CrdtLifecycleAction<T>, current: T, cleared: T): T {
  return action.kind === 'preserve'
    ? current
    : action.kind === 'clear'
      ? cleared
      : (action.value as T);
}

function writeAdmin(input: {
  readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
  readonly read: CrdtMutationRead;
  readonly document: RallarCrdtDocumentMetadata;
  readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
  readonly serviceId: string;
}): CrdtMutationComputedWrite {
  const { command, read, document, snapshot, serviceId } = input;
  const result = toCrdtMutationResult({
    command,
    status: 'accepted',
    document,
    appendSequence: document.lastAppendSequence,
    code: null,
    details: toAcceptedAdminResultDetails({ command, read, document, snapshot }),
  });
  const auditEvent =
    result.operation === 'erase' && result.status === 'accepted' ? result.auditEvent : null;
  return toAdminComputed({
    command,
    read,
    document,
    snapshot,
    outboxEntries: auditEvent ? [toCrdtAuditOutbox(auditEvent, command, serviceId)] : [],
    result,
    outcome: 'write',
  }) as CrdtMutationComputedWrite;
}

function rejectedAdmin(input: {
  readonly command: CrdtMutationCommand;
  readonly read: CrdtMutationRead;
  readonly code: string;
  readonly serviceId: string;
}): CrdtMutationComputedRejected {
  const { command, read, code } = input;
  if (command.operation === 'append') {
    throw new TypeError('CRDT administration rejection requires an administrative command');
  }
  const result = toCrdtMutationResult({
    command,
    status: 'rejected',
    document: read.document,
    appendSequence: null,
    code,
    details: toRejectedAdminResultDetails(command),
  });
  return {
    ...(toAdminComputed({
      command,
      read,
      document: read.document,
      snapshot: null,
      outboxEntries: [],
      result,
      outcome: 'rejected',
    }) as Omit<CrdtMutationComputedRejected, 'code'>),
    code,
  };
}

function toAdminComputed(input: {
  readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
  readonly read: CrdtMutationRead;
  readonly document: RallarCrdtDocumentMetadata | null;
  readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
  readonly outboxEntries: CrdtMutationComputed['outboxEntries'];
  readonly result: CrdtMutationComputed['result'];
  readonly outcome: 'write' | 'rejected';
}): CrdtMutationComputedWrite | Omit<CrdtMutationComputedRejected, 'code'> {
  return {
    command: input.command,
    read: input.read,
    operation: input.command.operation,
    commandId: input.command.commandId,
    commandHash: input.command.commandHash,
    documentKey: input.command.documentKey,
    expectedDocumentRevision: input.read.document?.documentRevision ?? 'absent',
    expectedDocumentLifecycle: input.read.document?.lifecycle ?? 'absent',
    expectedAppendSequence: input.read.document?.lastAppendSequence ?? 'absent',
    document: input.document as RallarCrdtDocumentMetadata,
    update: null,
    append: null,
    snapshot: input.snapshot,
    outboxEntries: input.outboxEntries,
    result: input.result,
    outcome: input.outcome,
  } as CrdtMutationComputedWrite | Omit<CrdtMutationComputedRejected, 'code'>;
}
