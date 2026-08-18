import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtCompactedSnapshot,
  createRallarCrdtDebugBundle,
  type RallarCrdtDocumentMetadata,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type { CrdtMutationComputed } from './crdt-mutation-contracts.ts';
import { type ComputeCrdtMutationInput, rejected, writeComputed } from './compute-crdt-mutation.ts';
import { toCrdtCanonicalSnapshotEnvelope } from './to-crdt-canonical-snapshot.ts';

export function computeCrdtProjectionRebuild(
  input: ComputeCrdtMutationInput,
): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'rebuild-projection') {
    throw new TypeError('CRDT projection rebuild computation requires a rebuild command');
  }
  if (!read.document) {
    return rejected({ command, read, code: 'document-not-found', serviceId });
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
    return rejected({ command, read, code: 'integrity-invalid', serviceId });
  }
  const document: RallarCrdtDocumentMetadata = {
    ...read.document,
    documentRevision: read.document.documentRevision + 1,
    updatedAtEpochMs: command.capturedAtEpochMs,
    projectionIds: [...new Set([...read.document.projectionIds, command.projectionId])],
  };
  return writeComputed({ command, read, document, snapshot: null, serviceId });
}

export function computeCrdtSnapshotCompact(input: ComputeCrdtMutationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'compact') {
    throw new TypeError('CRDT snapshot compaction requires a compact command');
  }
  if (!read.document) {
    return rejected({ command, read, code: 'document-not-found', serviceId });
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
    return rejected({ command, read, code: 'quota-exceeded', serviceId });
  }
  return writeComputed({ command, read, document, snapshot, serviceId });
}

export function computeCrdtLifecycleUpdate(input: ComputeCrdtMutationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'lifecycle') {
    throw new TypeError('CRDT lifecycle computation requires a lifecycle command');
  }
  if (!read.document) {
    return rejected({ command, read, code: 'document-not-found', serviceId });
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
  return writeComputed({ command, read, document, snapshot: null, serviceId });
}

export function computeCrdtErase(input: ComputeCrdtMutationInput): CrdtMutationComputed {
  const { command, read, serviceId } = input;
  if (command.operation !== 'erase') {
    throw new TypeError('CRDT erase computation requires an erase command');
  }
  if (!read.document) {
    return rejected({ command, read, code: 'document-not-found', serviceId });
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
  return writeComputed({ command, read, document, snapshot: null, serviceId });
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
