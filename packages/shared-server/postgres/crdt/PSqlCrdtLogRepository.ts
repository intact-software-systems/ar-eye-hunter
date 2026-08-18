import {
  createRallarCrdtAdminDocumentStatus,
  createRallarCrdtBackupBundle,
  createRallarCrdtDebugBundle,
  evaluateRallarCrdtFeaturePolicy,
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
  type RallarCrdtRestoreResult,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdatePage,
  type RallarCrdtValidationOptions,
  type RallarCrdtWriteSnapshotInput,
  toRallarCrdtAppendCursor,
  toRallarCrdtDocumentKey,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';
import type { PSqlSql } from '../PostgresSqlClient.ts';
import { rejectDirectCrdtMutation } from './psql-crdt-legacy-mutation.ts';
import {
  type DocumentRow,
  type SnapshotRow,
  toMetadata,
  toRecord,
  toSnapshot,
  toStoredMetadata,
  type UpdateRow,
} from './crdt-mutation-row-codec.ts';

export type PSqlCrdtLogRepositoryOptions = Readonly<{
  now?: () => number;
  serverId?: string;
  validation?: RallarCrdtValidationOptions;
  policies?: readonly RallarCrdtDocumentTypePolicy[];
  metrics?: RallarCrdtMetricsSink;
  audit?: RallarCrdtAuditSink;
  readonly [legacyOption: string]: unknown;
}>;

export class PSqlCrdtLogRepository<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
  TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
  private readonly now: () => number;
  private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  private readonly audit?: RallarCrdtAuditSink;

  private readonly sql: PSqlSql;

  constructor(sql: PSqlSql, options: PSqlCrdtLogRepositoryOptions = {}) {
    this.sql = sql;
    this.now = options.now ?? Date.now;
    this.policies = options.policies?.length
      ? options.policies
      : [{ documentType: '*', rollout: 'disabled' }];
    this.audit = options.audit;
  }

  append(_input: RallarCrdtAppendUpdateInput<TPayload>): Promise<RallarCrdtAppendResult<TPayload>> {
    return rejectDirectCrdtMutation();
  }

  appendBatch(
    _input: RallarCrdtAppendBatchInput<TPayload>,
  ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
    return rejectDirectCrdtMutation();
  }

  async listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage<TPayload>> {
    const documentKey = toRallarCrdtDocumentKey(input.document);
    const metadata = await this.readDocumentMetadata(input.document);
    const afterSequence = input.afterSequence ?? fromRallarCrdtAppendCursor(input.afterCursor) ?? 0;
    const limit = Math.max(0, input.limit ?? 100);
    const rows = await this.sql<UpdateRow[]>`
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
    if (!metadata && rows.length > 0) {
      throw new TypeError('CRDT persisted update has no document');
    }
    const selected = rows.slice(0, limit);
    const records = selected.map((row) => toRecord<TPayload>(row, input.document));
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
    const documentKey = toRallarCrdtDocumentKey(document);
    const metadata = await this.readDocumentMetadata(document);
    const rows = await this.sql<SnapshotRow[]>`
            select document_key, snapshot_id, append_sequence, snapshot_envelope,
                   created_at_ts, reason,
                   sum(octet_length(snapshot_envelope)) over () as snapshot_bytes,
                   count(*) over () as snapshot_count
            from crdt_snapshots
            where document_key = ${documentKey}
            order by append_sequence desc, created_at_ts desc
            limit 1
        `;
    if (!metadata) {
      if (rows.length > 0) {
        throw new TypeError('CRDT persisted snapshot has no document');
      }
      return undefined;
    }
    if (Number(rows[0]?.snapshot_count ?? 0) !== metadata.snapshotCount) {
      throw new TypeError('CRDT persisted snapshot count differs from document');
    }
    return rows[0]
      ? (toSnapshot({
          row: rows[0],
          expectedDocumentKey: documentKey,
          expectedDocument: document,
          lastAppendSequence: metadata.lastAppendSequence,
        }) as RallarCrdtSnapshotEnvelope<TValue>)
      : undefined;
  }

  writeSnapshot(_input: RallarCrdtWriteSnapshotInput<TValue>): Promise<void> {
    return rejectDirectCrdtMutation();
  }

  async readDocumentMetadata(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDocumentMetadata | undefined> {
    return await readDocumentMetadataByKey(this.sql, toRallarCrdtDocumentKey(document), document);
  }

  updateDocumentLifecycle(_input: RallarCrdtLifecycleInput): Promise<RallarCrdtDocumentMetadata> {
    return rejectDirectCrdtMutation();
  }

  async listDocuments(
    input: RallarCrdtListDocumentsInput = {},
  ): Promise<RallarCrdtDocumentAdminPage> {
    const rows = await this.sql<DocumentRow[]>`
            select document_key,
                   application_id,
                   workspace_id,
                   document_scope,
                   document_type,
                   document_id,
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
      .map(toStoredMetadata)
      .filter((metadata) => matchesDocumentListInput(metadata, input));
    const startIndex = input.cursor
      ? documents.findIndex((metadata) => metadata.documentKey > input.cursor!)
      : 0;
    const safeStartIndex = startIndex < 0 ? documents.length : startIndex;
    const selected = documents.slice(safeStartIndex, safeStartIndex + limit);

    return {
      documents: selected.map((metadata) =>
        createRallarCrdtAdminDocumentStatus({
          metadata,
          rollout: this.rolloutFor(metadata.document),
          quarantineReason:
            metadata.lifecycle === 'quarantined' ? 'document lifecycle is quarantined' : undefined,
        }),
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

  async verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport> {
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
    return evaluateRallarCrdtFeaturePolicy({
      document,
      operation: 'durable-append',
      policies: this.policies,
    }).rollout;
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
    (input.workspaceId === undefined || metadata.document.workspaceId === input.workspaceId) &&
    (input.scope === undefined || metadata.document.scope === input.scope) &&
    (input.documentType === undefined || metadata.document.documentType === input.documentType) &&
    (input.lifecycle === undefined || metadata.lifecycle === input.lifecycle)
  );
}

async function readDocumentMetadataByKey(
  sql: PSqlSql,
  documentKey: string,
  document: RallarCrdtDocumentRef,
): Promise<RallarCrdtDocumentMetadata | undefined> {
  const rows = await sql<DocumentRow[]>`
            select document_key,
                   application_id,
                   workspace_id,
                   document_scope,
                   document_type,
                   document_id,
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

  return rows[0] ? toMetadata(rows[0], documentKey, document) : undefined;
}
