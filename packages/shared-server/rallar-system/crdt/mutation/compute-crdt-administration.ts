import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtDebugBundle,
  type RallarCrdtDocumentMetadata,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type {
  CrdtLifecycleFieldAction,
  CrdtMutationCommand,
  CrdtMutationComputed,
  CrdtMutationRead,
} from './crdt-mutation-contracts.ts';
import {
  computeCrdtAcceptedAdministrationOutcome,
  computeCrdtRejectedOutcome,
} from './compute-crdt-mutation-outcome.ts';
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
    return computeCrdtRejectedOutcome({ command, read, code: 'document-not-found', serviceId });
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
    return computeCrdtRejectedOutcome({ command, read, code: 'integrity-invalid', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds: [...new Set([...read.document.projectionIds, command.projectionId])],
  };
  return computeCrdtAcceptedAdministrationOutcome({
    command,
    read,
    document,
    snapshot: null,
    serviceId,
  });
}

export function computeCrdtSnapshotCompact(
  input: ComputeCrdtAdministrationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'compact') {
    throw new TypeError('CRDT snapshot compaction requires a compact command');
  }
  if (!read.document) {
    return computeCrdtRejectedOutcome({ command, read, code: 'document-not-found', serviceId });
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
    return computeCrdtRejectedOutcome({ command, read, code: 'quota-exceeded', serviceId });
  }
  return computeCrdtAcceptedAdministrationOutcome({
    command,
    read,
    document,
    snapshot,
    serviceId,
  });
}

export function computeCrdtLifecycleUpdate(
  input: ComputeCrdtAdministrationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'lifecycle') {
    throw new TypeError('CRDT lifecycle computation requires a lifecycle command');
  }
  if (!read.document) {
    return computeCrdtRejectedOutcome({ command, read, code: 'document-not-found', serviceId });
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
  return computeCrdtAcceptedAdministrationOutcome({
    command,
    read,
    document,
    snapshot: null,
    serviceId,
  });
}

export function computeCrdtErase(input: ComputeCrdtAdministrationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'erase') {
    throw new TypeError('CRDT erase computation requires an erase command');
  }
  if (!read.document) {
    return computeCrdtRejectedOutcome({ command, read, code: 'document-not-found', serviceId });
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
  return computeCrdtAcceptedAdministrationOutcome({
    command,
    read,
    document,
    snapshot: null,
    serviceId,
  });
}

function applyLifecycleAction<T>(action: CrdtLifecycleFieldAction<T>, current: T, cleared: T): T {
  switch (action.kind) {
    case 'preserve':
      return current;
    case 'clear':
      return cleared;
    case 'set':
      return action.value;
  }
}
