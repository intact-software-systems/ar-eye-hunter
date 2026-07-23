import {
  createRallarCrdtAdminDocumentStatus,
  createRallarCrdtBackupBundle,
  createRallarCrdtDebugBundle,
  fromRallarCrdtAppendCursor,
  type RallarCrdtAdminLogRepository,
  type RallarCrdtAppendBatchInput,
  type RallarCrdtAppendBatchResult,
  type RallarCrdtAppendResult,
  type RallarCrdtAppendUpdateInput,
  type RallarCrdtAuditEventKind,
  type RallarCrdtAuditSink,
  type RallarCrdtBackupBundle,
  type RallarCrdtDebugBundle,
  type RallarCrdtDebugBundleRedaction,
  type RallarCrdtDocumentAdminPage,
  type RallarCrdtDocumentLifecycleState,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtDurableUpdateRecord,
  type RallarCrdtIntegrityReport,
  type RallarCrdtLifecycleInput,
  type RallarCrdtListDocumentsInput,
  type RallarCrdtListUpdatesInput,
  type RallarCrdtMetricsSink,
  type RallarCrdtOperationBatch,
  type RallarCrdtQuotaPolicy,
  type RallarCrdtRestoreResult,
  type RallarCrdtRetentionPolicy,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtTrustedAppendMetadata,
  type RallarCrdtUpdateEnvelope,
  type RallarCrdtUpdatePage,
  type RallarCrdtValidationOptions,
  type RallarCrdtWriteSnapshotInput,
  toRallarCrdtAppendCursor,
  toRallarCrdtDocumentKey,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { rejectDirectCrdtMutation } from './psql-crdt-legacy-mutation.ts';

export type PSqlCrdtLogRepositoryOptions = Readonly<{
  now?: () => number;
  serverId?: string;
  validation?: RallarCrdtValidationOptions;
  policies?: readonly RallarCrdtDocumentTypePolicy[];
  metrics?: RallarCrdtMetricsSink;
  audit?: RallarCrdtAuditSink;
  readonly [legacyOption: string]: unknown;
}>;

type CrdtDocumentRow = Readonly<{
  document_key: string;
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

type CrdtUpdateRow = Readonly<{
  document_key: string;
  append_sequence: number | string;
  update_id: string;
  update_envelope: string;
  accepted_update_hash: string;
  actor_id: string | null;
  principal_id: string | null;
  session_id: string | null;
  server_id: string | null;
  authorization_scope: string;
  accepted_at_ts: Date | string;
}>;

type CrdtSnapshotRow = Readonly<{
  snapshot_envelope: string;
}>;

export class PSqlCrdtLogRepository<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
  TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
  private readonly now: () => number;
  private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  private readonly audit?: RallarCrdtAuditSink;

  constructor(
    private readonly sql: PSqlSql,
    options: PSqlCrdtLogRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.policies = options.policies ?? [];
    this.audit = options.audit;
  }

  append(
    _input: RallarCrdtAppendUpdateInput<TPayload>,
  ): Promise<RallarCrdtAppendResult<TPayload>> {
    return rejectDirectCrdtMutation();
  }

  appendBatch(
    _input: RallarCrdtAppendBatchInput<TPayload>,
  ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
    return rejectDirectCrdtMutation();
  }

  async listAfter(
    input: RallarCrdtListUpdatesInput,
  ): Promise<RallarCrdtUpdatePage<TPayload>> {
    const documentKey = toRallarCrdtDocumentKey(input.document);
    const afterSequence = input.afterSequence ??
      fromRallarCrdtAppendCursor(input.afterCursor) ??
      0;
    const limit = Math.max(0, input.limit ?? 100);
    const rows = await this.sql<CrdtUpdateRow[]>`
            select document_key,
                   append_sequence,
                   update_id,
                   update_envelope,
                   accepted_update_hash,
                   actor_id,
                   principal_id,
                   session_id,
                   server_id,
                   authorization_scope,
                   accepted_at_ts
            from crdt_updates
            where document_key = ${documentKey}
              and append_sequence > ${afterSequence}
            order by append_sequence
            limit ${limit + 1}
        `;
    const selected = rows.slice(0, limit);
    const records = selected.map((row) => toUpdateRecord<TPayload>(row, input.document));
    const lastSequence = records.at(-1)?.append.appendSequence;

    return {
      document: input.document,
      records,
      firstSequence: records[0]?.append.appendSequence,
      lastSequence,
      nextCursor: lastSequence !== undefined ? toRallarCrdtAppendCursor(lastSequence) : undefined,
      hasMore: rows.length > selected.length,
    };
  }

  async readSnapshot(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined> {
    const rows = await this.sql<CrdtSnapshotRow[]>`
            select snapshot_envelope
            from crdt_snapshots
            where document_key = ${toRallarCrdtDocumentKey(document)}
            order by append_sequence desc, created_at_ts desc
            limit 1
        `;

    return rows[0]
      ? (JSON.parse(
        rows[0].snapshot_envelope,
      ) as RallarCrdtSnapshotEnvelope<TValue>)
      : undefined;
  }

  writeSnapshot(
    _input: RallarCrdtWriteSnapshotInput<TValue>,
  ): Promise<void> {
    return rejectDirectCrdtMutation();
  }

  async readDocumentMetadata(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDocumentMetadata | undefined> {
    return await readDocumentMetadataByKey(
      this.sql,
      toRallarCrdtDocumentKey(document),
    );
  }

  updateDocumentLifecycle(
    _input: RallarCrdtLifecycleInput,
  ): Promise<RallarCrdtDocumentMetadata> {
    return rejectDirectCrdtMutation();
  }

  async listDocuments(
    input: RallarCrdtListDocumentsInput = {},
  ): Promise<RallarCrdtDocumentAdminPage> {
    const rows = await this.sql<CrdtDocumentRow[]>`
            select document_key,
                   document_ref,
                   document_revision,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   stored_update_bytes,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            order by document_key
        `;
    const limit = Math.max(0, input.limit ?? 100);
    const documents = rows
      .map(toDocumentMetadata)
      .filter((metadata) => matchesDocumentListInput(metadata, input));
    const startIndex = input.cursor
      ? documents.findIndex(
        (metadata) => metadata.documentKey > input.cursor!,
      )
      : 0;
    const safeStartIndex = startIndex < 0 ? documents.length : startIndex;
    const selected = documents.slice(
      safeStartIndex,
      safeStartIndex + limit,
    );

    return {
      documents: selected.map((metadata) =>
        createRallarCrdtAdminDocumentStatus({
          metadata,
          rollout: this.rolloutFor(metadata.document),
          quarantineReason: metadata.lifecycle === 'quarantined'
            ? 'document lifecycle is quarantined'
            : undefined,
        })
      ),
      nextCursor: selected.at(-1)?.documentKey,
      hasMore: safeStartIndex + selected.length < documents.length,
    };
  }

  async exportDebugBundle(
    document: RallarCrdtDocumentRef,
    options: Readonly<{
      reason?: string;
      exportedAtEpochMs?: number;
      redaction?: RallarCrdtDebugBundleRedaction;
    }> = {},
  ): Promise<RallarCrdtDebugBundle<TPayload>> {
    const [metadata, snapshot, records] = await Promise.all([
      this.readDocumentMetadata(document),
      this.readSnapshot(document),
      this.readAllRecords(document),
    ]);
    this.recordAudit('export', toRallarCrdtDocumentKey(document), {
      reason: options.reason ?? 'operator-export',
      redacted: options.redaction?.payloadsRedacted ?? false,
    });

    return createRallarCrdtDebugBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
      reason: options.reason ?? 'operator-export',
      document,
      metadata,
      snapshot: snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records,
      redaction: options.redaction,
    });
  }

  async exportBackupBundle(
    document: RallarCrdtDocumentRef,
    options: Readonly<{
      exportedAtEpochMs?: number;
    }> = {},
  ): Promise<RallarCrdtBackupBundle<TPayload> | undefined> {
    const [metadata, snapshot, records] = await Promise.all([
      this.readDocumentMetadata(document),
      this.readSnapshot(document),
      this.readAllRecords(document),
    ]);
    if (!metadata) {
      return undefined;
    }

    this.recordAudit('backup', metadata.documentKey);
    return createRallarCrdtBackupBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.now(),
      document,
      metadata,
      snapshot: snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records,
    });
  }

  restoreBackupBundle(
    _bundle: RallarCrdtBackupBundle<TPayload>,
    _options: Readonly<{
      overwrite?: boolean;
    }> = {},
  ): Promise<RallarCrdtRestoreResult> {
    return rejectDirectCrdtMutation();
  }

  async verifyIntegrity(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtIntegrityReport> {
    return verifyRallarCrdtDebugBundle(
      await this.exportDebugBundle(document, {
        reason: 'integrity-check',
      }),
    );
  }

  rebuildProjection(
    _document: RallarCrdtDocumentRef,
    _projectionId = 'default',
  ): Promise<RallarCrdtIntegrityReport> {
    return rejectDirectCrdtMutation();
  }

  private async readAllRecords(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDurableUpdateRecord<TPayload>[]> {
    const records: RallarCrdtDurableUpdateRecord<TPayload>[] = [];
    let cursor: string | undefined;

    do {
      const page = await this.listAfter({
        document,
        afterCursor: cursor,
        limit: 500,
      });
      records.push(...page.records);
      cursor = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    } while (cursor);

    return records;
  }

  private rolloutFor(document: RallarCrdtDocumentRef) {
    return (
      this.policies.find(
        (policy) =>
          (policy.documentType === '*' ||
            policy.documentType === document.documentType) &&
          (policy.scope === undefined ||
            policy.scope === 'any' ||
            policy.scope === document.scope) &&
          (policy.applicationId === undefined ||
            policy.applicationId === document.applicationId) &&
          (policy.workspaceId === undefined ||
            policy.workspaceId === document.workspaceId),
      )?.rollout ?? 'production'
    );
  }

  private recordAudit(
    kind: RallarCrdtAuditEventKind,
    documentKey: string | undefined,
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    void this.audit?.record({
      kind,
      atEpochMs: this.now(),
      documentKey,
      metadata,
    });
  }
}

function matchesDocumentListInput(
  metadata: RallarCrdtDocumentMetadata,
  input: RallarCrdtListDocumentsInput,
): boolean {
  return (
    (input.applicationId === undefined ||
      metadata.document.applicationId === input.applicationId) &&
    (input.workspaceId === undefined ||
      metadata.document.workspaceId === input.workspaceId) &&
    (input.scope === undefined ||
      metadata.document.scope === input.scope) &&
    (input.documentType === undefined ||
      metadata.document.documentType === input.documentType) &&
    (input.lifecycle === undefined ||
      metadata.lifecycle === input.lifecycle)
  );
}

async function readDocumentMetadataByKey(
  sql: PSqlSql,
  documentKey: string,
  _forUpdate = false,
): Promise<RallarCrdtDocumentMetadata | undefined> {
  const rows = await sql<CrdtDocumentRow[]>`
            select document_key,
                   document_ref,
                   document_revision,
                   lifecycle,
                   created_at_ts,
                   updated_at_ts,
                   archived_at_ts,
                   destroyed_at_ts,
                   last_append_sequence,
                   update_count,
                   snapshot_count,
                   stored_update_bytes,
                   retention_policy,
                   quota_policy,
                   projection_ids
            from crdt_documents
            where document_key = ${documentKey}
            limit 1
        `;

  return rows[0] ? toDocumentMetadata(rows[0]) : undefined;
}

function toDocumentMetadata(row: CrdtDocumentRow): RallarCrdtDocumentMetadata {
  return {
    document: JSON.parse(row.document_ref) as RallarCrdtDocumentRef,
    documentKey: row.document_key,
    documentRevision: Number(row.document_revision),
    lifecycle: row.lifecycle as RallarCrdtDocumentLifecycleState,
    createdAtEpochMs: toEpochMs(row.created_at_ts),
    updatedAtEpochMs: toEpochMs(row.updated_at_ts),
    archivedAtEpochMs: toOptionalEpochMs(row.archived_at_ts) ?? null,
    destroyedAtEpochMs: toOptionalEpochMs(row.destroyed_at_ts) ?? null,
    lastAppendSequence: Number(row.last_append_sequence),
    updateCount: Number(row.update_count),
    snapshotCount: Number(row.snapshot_count),
    storedUpdateBytes: Number(row.stored_update_bytes),
    retention: parseNullableJson<RallarCrdtRetentionPolicy>(
      row.retention_policy,
    ) ?? null,
    quota: parseNullableJson<RallarCrdtQuotaPolicy>(row.quota_policy) ?? null,
    projectionIds: parseNullableJson<readonly string[]>(row.projection_ids) ?? [],
  };
}

function toUpdateRecord<TPayload extends RallarCrdtOperationBatch>(
  row: CrdtUpdateRow,
  document: RallarCrdtDocumentRef,
): RallarCrdtDurableUpdateRecord<TPayload> {
  return {
    document,
    documentKey: row.document_key,
    update: JSON.parse(
      row.update_envelope,
    ) as RallarCrdtUpdateEnvelope<TPayload>,
    append: toAppendMetadata(row),
  };
}

function toAppendMetadata(row: CrdtUpdateRow): RallarCrdtTrustedAppendMetadata {
  return {
    appendSequence: Number(row.append_sequence),
    acceptedAtEpochMs: toEpochMs(row.accepted_at_ts),
    actorId: requireTrustedId(row.actor_id ?? undefined, 'actorId'),
    principalId: requireTrustedId(row.principal_id ?? undefined, 'principalId'),
    sessionId: requireTrustedId(row.session_id ?? undefined, 'sessionId'),
    serverId: requireTrustedId(row.server_id ?? undefined, 'serverId'),
    authorizationScope: row.authorization_scope as never,
    acceptedUpdateHash: row.accepted_update_hash,
  };
}

function requireTrustedId(value: string | undefined, label: string): string {
  if (!value) throw new TypeError(`CRDT trusted ${label} is required`);
  return value;
}

function toEpochMs(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid CRDT timestamp: ${String(value)}`);
  }
  return timestamp;
}

function toOptionalEpochMs(value: Date | string | null): number | undefined {
  return value === null ? undefined : toEpochMs(value);
}

function parseNullableJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}
