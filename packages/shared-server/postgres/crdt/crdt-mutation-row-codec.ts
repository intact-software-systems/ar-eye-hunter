import {
  evaluateRallarCrdtFeaturePolicy,
  hashRallarCrdtUpdateEnvelope,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtFeatureDecision,
  type RallarCrdtQuotaPolicy,
  type RallarCrdtRetentionPolicy,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtTrustedAppendMetadata,
  toRallarCrdtDocumentKey,
  validateRallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import type { CrdtMutationCommand } from '../../rallar-system/services/crdt-mutation-contracts.ts';
import { decodeExactUpdateEnvelope } from '../../rallar-system/services/crdt-mutation-codec.ts';

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
}>;

export function toMetadata(
  row: DocumentRow,
  expectedDocumentKey: string,
  expectedDocument: RallarCrdtDocumentRef,
): RallarCrdtDocumentMetadata {
  const document = decodeDocumentRef(row.document_ref);
  const logicalKey = toRallarCrdtDocumentKey(document);
  const expectedKey = toRallarCrdtDocumentKey(expectedDocument);
  if (
    row.document_key !== expectedDocumentKey || logicalKey !== row.document_key ||
    expectedKey !== row.document_key || row.application_id !== document.applicationId ||
    row.workspace_id !== (document.workspaceId ?? null) ||
    row.document_scope !== document.scope || row.document_type !== document.documentType ||
    row.document_id !== document.documentId
  ) throw new TypeError('CRDT persisted document identity is corrupt');
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
    counters[0] < 1 || !['active', 'archived', 'destroyed', 'quarantined'].includes(lifecycle) ||
    !Number.isSafeInteger(createdAtEpochMs) || !Number.isSafeInteger(updatedAtEpochMs) ||
    createdAtEpochMs < 0 || updatedAtEpochMs < createdAtEpochMs ||
    !isRetentionPolicy(retention) || !isQuotaPolicy(quota) ||
    !Array.isArray(projectionIds) || projectionIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(projectionIds).size !== projectionIds.length
  ) throw new TypeError('CRDT persisted document metadata is corrupt');
  return {
    document,
    documentKey: row.document_key,
    documentRevision: counters[0],
    lifecycle,
    createdAtEpochMs,
    updatedAtEpochMs,
    archivedAtEpochMs: toEpoch(row.archived_at_ts),
    destroyedAtEpochMs: toEpoch(row.destroyed_at_ts),
    lastAppendSequence: counters[1],
    updateCount: counters[2],
    snapshotCount: counters[3],
    storedUpdateBytes: counters[4],
    retention,
    quota,
    projectionIds,
  };
}

export function toRecord(
  row: UpdateRow,
  document: RallarCrdtDocumentRef,
): RallarCrdtDurableUpdateRecord {
  const update = decodeExactUpdateEnvelope(JSON.parse(row.update_envelope));
  const expectedKey = toRallarCrdtDocumentKey(document);
  if (
    row.document_key !== expectedKey ||
    row.update_id !== update.updateId ||
    toRallarCrdtDocumentKey(update.document) !== expectedKey ||
    hashRallarCrdtUpdateEnvelope(update) !== row.accepted_update_hash ||
    row.actor_id === null || row.principal_id === null ||
    row.session_id === null || row.server_id === null
  ) throw new TypeError('CRDT persisted update identity is corrupt');
  return {
    document,
    documentKey: row.document_key,
    update,
    append: {
      appendSequence: Number(row.append_sequence),
      acceptedAtEpochMs: new Date(row.accepted_at_ts).getTime(),
      actorId: row.actor_id,
      principalId: row.principal_id,
      sessionId: row.session_id,
      serverId: row.server_id,
      authorizationScope: row
        .authorization_scope as RallarCrdtTrustedAppendMetadata['authorizationScope'],
      acceptedUpdateHash: row.accepted_update_hash,
    },
  };
}

export function toSnapshot(
  row: SnapshotRow,
  expectedDocumentKey: string,
  expectedDocument: RallarCrdtDocumentRef,
  lastAppendSequence: number,
): RallarCrdtSnapshotEnvelope {
  const snapshot = JSON.parse(row.snapshot_envelope) as RallarCrdtSnapshotEnvelope;
  if (
    row.document_key !== expectedDocumentKey ||
    row.snapshot_id !== snapshot.snapshotId ||
    !Number.isSafeInteger(Number(row.append_sequence)) ||
    Number(row.append_sequence) < 0 ||
    Number(row.append_sequence) > lastAppendSequence ||
    new Date(row.created_at_ts).getTime() !== snapshot.createdAtEpochMs ||
    row.reason !== (snapshot.metadata.reason ?? 'app-inbox-compaction') ||
    toRallarCrdtDocumentKey(snapshot.document) !== expectedDocumentKey ||
    toRallarCrdtDocumentKey(expectedDocument) !== expectedDocumentKey ||
    !validateRallarCrdtSnapshotEnvelope(snapshot).valid
  ) throw new TypeError('CRDT persisted snapshot identity is corrupt');
  return snapshot;
}

export function toFeatureDecision(
  command: CrdtMutationCommand,
  policies: readonly RallarCrdtDocumentTypePolicy[],
): RallarCrdtFeatureDecision {
  if (command.operation === 'append' || command.operation === 'rebuild-projection') {
    return evaluateRallarCrdtFeaturePolicy({
      document: command.document,
      operation: command.operation === 'append' ? 'durable-append' : 'projection-rebuild',
      policies,
    });
  }
  return {
    allowed: true,
    code: 'allowed',
    reason: 'No feature gate applies to this administrative mutation.',
    rollout: 'production',
    retryable: false,
  };
}

export function toDate(epochMs: number | null): Date | null {
  return epochMs === null ? null : new Date(epochMs);
}

export function toJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function decodeDocumentRef(value: string): RallarCrdtDocumentRef {
  const document = JSON.parse(value) as unknown;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError('CRDT persisted document identity is corrupt');
  }
  const record = document as Record<string, unknown>;
  const allowed = [
    'applicationId',
    'scope',
    'documentType',
    'documentId',
    ...('workspaceId' in record ? ['workspaceId'] : []),
    ...('roomRef' in record ? ['roomRef'] : []),
    ...('principalId' in record ? ['principalId'] : []),
    ...('customScope' in record ? ['customScope'] : []),
  ];
  if (Object.keys(record).sort().join('\0') !== allowed.sort().join('\0')) {
    throw new TypeError('CRDT persisted document identity is corrupt');
  }
  toRallarCrdtDocumentKey(record as RallarCrdtDocumentRef);
  return record as RallarCrdtDocumentRef;
}

function toEpoch(value: Date | string | null): number | null {
  return value === null ? null : new Date(value).getTime();
}

function fromJson<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

function isRetentionPolicy(value: unknown): value is RallarCrdtRetentionPolicy | null {
  if (value === null) return true;
  if (!isExactOptionalRecord(value, ['mode'], ['ttlMs', 'sensitivePayloads', 'reason'])) {
    return false;
  }
  return ['retain', 'redact-after', 'delete-after'].includes(String(value.mode)) &&
    (value.ttlMs === undefined || isPositiveInteger(value.ttlMs)) &&
    (value.sensitivePayloads === undefined || typeof value.sensitivePayloads === 'boolean') &&
    (value.reason === undefined || typeof value.reason === 'string');
}

function isQuotaPolicy(value: unknown): value is RallarCrdtQuotaPolicy | null {
  if (value === null) return true;
  const keys = [
    'maxUpdateBytes',
    'maxDocumentBytes',
    'maxUpdateCount',
    'maxPendingUpdatesPerReplica',
    'maxUpdatesPerMinutePerActor',
  ];
  return isExactOptionalRecord(value, [], keys) &&
    keys.every((key) => value[key] === undefined || isPositiveInteger(value[key]));
}

function isExactOptionalRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
