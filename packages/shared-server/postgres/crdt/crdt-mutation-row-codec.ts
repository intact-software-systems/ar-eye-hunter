import {
  evaluateRallarCrdtFeaturePolicy,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtFeatureDecision,
  type RallarCrdtOperationBatch,
  type RallarCrdtQuotaPolicy,
  type RallarCrdtRetentionPolicy,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdateEnvelope,
  toRallarCrdtDocumentKey,
  validateRallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import type * as Crdt from '../../rallar-system/crdt/mutation/crdt-mutation-contracts.ts';
import {
  decodeExactDocumentMetadata,
  decodeExactDocumentRef,
  decodeExactQuotaPolicy,
  decodeExactRetentionPolicy,
  decodeExactSnapshotEnvelope,
  decodeExactTrustedAppendMetadata,
} from '../../rallar-system/crdt/mutation/crdt-mutation-value-codec.ts';
import * as CrdtUpdate from '../../rallar-system/crdt/mutation/decode-exact-update-envelope.ts';

export type DocumentRow = Readonly<{
  document_key: string;
  application_id: string;
  workspace_id: string | null;
  document_scope: string;
  document_type: string;
  document_id: string;
  document_ref: string;
  document_revision: number | string;
  lifecycle: string;
  created_at_ts: Date | string;
  updated_at_ts: Date | string;
  archived_at_ts: Date | string | null;
  destroyed_at_ts: Date | string | null;
  last_append_sequence: number | string;
  update_count: number | string;
  snapshot_count: number | string;
  stored_update_bytes: number | string;
  retention_policy: string | null;
  quota_policy: string | null;
  projection_ids: string | null;
}>;

export type UpdateRow = Readonly<{
  document_key: string;
  update_id: string;
  append_sequence: number | string;
  update_envelope: string;
  accepted_update_hash: string;
  actor_id: string | null;
  principal_id: string | null;
  session_id: string | null;
  server_id: string | null;
  authorization_scope: string;
  accepted_at_ts: Date | string;
}>;

export type SnapshotRow = Readonly<{
  document_key: string;
  snapshot_id: string;
  append_sequence: number | string;
  snapshot_envelope: string;
  created_at_ts: Date | string;
  reason: string;
  snapshot_bytes: number | string;
  snapshot_count: number | string;
}>;

export function toMetadata(
  row: DocumentRow,
  expectedDocumentKey: string,
  expectedDocument: RallarCrdtDocumentRef,
): RallarCrdtDocumentMetadata {
  const document = decodeDocumentRef(row.document_ref);
  const logicalKey = toRallarCrdtDocumentKey(document);
  const expectedKey = toRallarCrdtDocumentKey(expectedDocument);
  const archivedAtEpochMs = toEpoch(row.archived_at_ts);
  const destroyedAtEpochMs = toEpoch(row.destroyed_at_ts);
  if (
    row.document_key !== expectedDocumentKey ||
    logicalKey !== row.document_key ||
    expectedKey !== row.document_key ||
    row.application_id !== document.applicationId ||
    row.workspace_id !== (document.workspaceId ?? null) ||
    row.document_scope !== document.scope ||
    row.document_type !== document.documentType ||
    row.document_id !== document.documentId
  )
    throw new TypeError('CRDT persisted document identity is corrupt');
  const counters = [
    row.document_revision,
    row.last_append_sequence,
    row.update_count,
    row.snapshot_count,
    row.stored_update_bytes,
  ].map(Number);
  const lifecycle = row.lifecycle as RallarCrdtDocumentLifecycleState;
  const createdAtEpochMs = new Date(row.created_at_ts).getTime();
  const updatedAtEpochMs = new Date(row.updated_at_ts).getTime();
  const retention = fromJson<RallarCrdtRetentionPolicy>(row.retention_policy);
  const quota = fromJson<RallarCrdtQuotaPolicy>(row.quota_policy);
  const projectionIds = fromJson<readonly string[]>(row.projection_ids) ?? [];
  if (
    !counters.every((counter) => Number.isSafeInteger(counter) && counter >= 0) ||
    counters[0] < 1 ||
    !['active', 'archived', 'destroyed', 'quarantined'].includes(lifecycle) ||
    !Number.isSafeInteger(createdAtEpochMs) ||
    !Number.isSafeInteger(updatedAtEpochMs) ||
    createdAtEpochMs < 0 ||
    updatedAtEpochMs < createdAtEpochMs ||
    (retention !== null && !decodePolicy(() => decodeExactRetentionPolicy(retention))) ||
    (quota !== null && !decodePolicy(() => decodeExactQuotaPolicy(quota))) ||
    !Array.isArray(projectionIds) ||
    projectionIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(projectionIds).size !== projectionIds.length
  )
    throw new TypeError('CRDT persisted document metadata is corrupt');
  return decodeExactDocumentMetadata({
    document,
    documentKey: row.document_key,
    documentRevision: counters[0],
    lifecycle,
    createdAtEpochMs,
    updatedAtEpochMs,
    archivedAtEpochMs,
    destroyedAtEpochMs,
    lastAppendSequence: counters[1],
    updateCount: counters[2],
    snapshotCount: counters[3],
    storedUpdateBytes: counters[4],
    retention,
    quota,
    projectionIds,
  });
}

export function toStoredMetadata(row: DocumentRow): RallarCrdtDocumentMetadata {
  const document = decodeDocumentRef(row.document_ref);
  return toMetadata(row, row.document_key, document);
}

export function toRecord<TPayload extends RallarCrdtOperationBatch>(
  row: UpdateRow,
  document: RallarCrdtDocumentRef,
): RallarCrdtDurableUpdateRecord<TPayload> {
  const update = CrdtUpdate.decodeExactUpdateEnvelope(
    JSON.parse(row.update_envelope),
  ) as RallarCrdtUpdateEnvelope<TPayload>;
  const expectedKey = toRallarCrdtDocumentKey(document);
  const appendSequence = Number(row.append_sequence);
  const acceptedAtEpochMs = new Date(row.accepted_at_ts).getTime();
  if (
    row.document_key !== expectedKey ||
    row.update_id !== update.updateId ||
    toRallarCrdtDocumentKey(update.document) !== expectedKey ||
    hashRallarCrdtUpdateEnvelope(update) !== row.accepted_update_hash ||
    row.actor_id === null ||
    row.principal_id === null ||
    row.session_id === null ||
    row.server_id === null ||
    !Number.isSafeInteger(appendSequence) ||
    appendSequence <= 0 ||
    !Number.isSafeInteger(acceptedAtEpochMs) ||
    acceptedAtEpochMs < 0 ||
    row.authorization_scope !== document.scope
  )
    throw new TypeError('CRDT persisted update identity is corrupt');
  const append = decodeExactTrustedAppendMetadata({
    appendSequence,
    acceptedAtEpochMs,
    actorId: row.actor_id,
    principalId: row.principal_id,
    sessionId: row.session_id,
    serverId: row.server_id,
    authorizationScope: row.authorization_scope,
    acceptedUpdateHash: row.accepted_update_hash,
  });
  return {
    document,
    documentKey: row.document_key,
    update,
    append,
  };
}

export function toSnapshot(
  row: SnapshotRow,
  expectedDocumentKey: string,
  expectedDocument: RallarCrdtDocumentRef,
  lastAppendSequence: number,
): RallarCrdtSnapshotEnvelope {
  const snapshot = decodeExactSnapshotEnvelope(JSON.parse(row.snapshot_envelope));
  const expectedReason = snapshot.metadata.reason ?? 'legacy-import';
  if (
    row.document_key !== expectedDocumentKey ||
    row.snapshot_id !== snapshot.snapshotId ||
    !Number.isSafeInteger(Number(row.append_sequence)) ||
    Number(row.append_sequence) < 0 ||
    Number(row.append_sequence) > lastAppendSequence ||
    new Date(row.created_at_ts).getTime() !== snapshot.createdAtEpochMs ||
    typeof row.reason !== 'string' ||
    row.reason.length === 0 ||
    row.reason !== expectedReason ||
    toRallarCrdtDocumentKey(snapshot.document) !== expectedDocumentKey ||
    toRallarCrdtDocumentKey(expectedDocument) !== expectedDocumentKey ||
    !validateRallarCrdtSnapshotEnvelope(snapshot).valid
  )
    throw new TypeError('CRDT persisted snapshot identity is corrupt');
  return snapshot;
}

export function toFeatureDecision(
  command: Crdt.CrdtMutationCommand,
  policies: readonly RallarCrdtDocumentTypePolicy[],
): RallarCrdtFeatureDecision {
  return evaluateRallarCrdtFeaturePolicy({
    document: command.document,
    operation:
      command.operation === 'append'
        ? 'durable-append'
        : command.operation === 'rebuild-projection'
          ? 'projection-rebuild'
          : 'admin-export',
    policies,
  });
}

export function toDate(epochMs: number | null): Date | null {
  return epochMs === null ? null : new Date(epochMs);
}

export function toJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function decodeDocumentRef(value: string): RallarCrdtDocumentRef {
  return decodeExactDocumentRef(JSON.parse(value), 'CRDT persisted document identity');
}

function toEpoch(value: Date | string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}

function fromJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function decodePolicy(decode: () => unknown): boolean {
  try {
    decode();
    return true;
  } catch {
    return false;
  }
}
