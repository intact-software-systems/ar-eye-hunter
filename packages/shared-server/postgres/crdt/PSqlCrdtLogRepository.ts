import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtAdminDocumentStatus,
  createRallarCrdtBackupBundle,
  createRallarCrdtDebugBundle,
  evaluateRallarCrdtFeaturePolicy,
  fromRallarCrdtAppendCursor,
  hashRallarCrdtUpdateEnvelope,
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
  private readonly serverId?: string;
  private readonly validation?: RallarCrdtValidationOptions;
  private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  private readonly metrics?: RallarCrdtMetricsSink;
  private readonly audit?: RallarCrdtAuditSink;

  constructor(
    private readonly sql: PSqlSql,
    options: PSqlCrdtLogRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.serverId = options.serverId;
    this.validation = options.validation;
    this.policies = options.policies ?? [];
    this.metrics = options.metrics;
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

  private async appendInTransaction(
    tx: PSqlSql,
    input: RallarCrdtAppendUpdateInput<TPayload>,
    startedAtEpochMs: number,
  ): Promise<RallarCrdtAppendResult<TPayload>> {
    const actorId = requireTrustedId(input.trusted.actorId, 'actorId');
    const principalId = requireTrustedId(input.trusted.principalId, 'principalId');
    const sessionId = requireTrustedId(input.trusted.sessionId, 'sessionId');
    const serverId = requireTrustedId(input.trusted.serverId ?? this.serverId, 'serverId');
    const acceptedAtEpochMs = input.trusted.acceptedAtEpochMs ?? this.now();
    const documentKey = toRallarCrdtDocumentKey(input.update.document);
    await ensureDocument(tx, input.update.document, acceptedAtEpochMs);
    const metadata = await requireDocumentMetadataByKey(
      tx,
      documentKey,
      true,
    );
    const policyDecision = evaluateRallarCrdtFeaturePolicy({
      document: input.update.document,
      operation: 'durable-append',
      policies: this.policies,
    });
    if (!policyDecision.allowed) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'feature-disabled',
        reason: policyDecision.reason,
        retryable: policyDecision.retryable,
        document: metadata,
      });
    }
    const acceptedUpdateHash = hashRallarCrdtUpdateEnvelope(input.update);
    const duplicateRows = await tx<CrdtUpdateRow[]>`
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
              and update_id = ${input.update.updateId}
            limit 1
        `;
    const duplicate = duplicateRows[0];
    if (duplicate) {
      const append = toAppendMetadata(duplicate);
      if (append.acceptedUpdateHash === acceptedUpdateHash) {
        return this.recordAppendResult(startedAtEpochMs, {
          status: 'duplicate',
          update: input.update,
          append,
          document: metadata,
        });
      }

      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'duplicate-hash-mismatch',
        reason: 'CRDT updateId already exists with a different canonical hash.',
        retryable: false,
        document: metadata,
      });
    }

    if (metadata.lifecycle === 'archived') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-archived',
        reason: 'CRDT document is archived and no longer accepts writes.',
        retryable: false,
        document: metadata,
      });
    }
    if (metadata.lifecycle === 'destroyed') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-destroyed',
        reason: 'CRDT document is destroyed and no longer accepts writes.',
        retryable: false,
        document: metadata,
      });
    }
    if (metadata.lifecycle === 'quarantined') {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'document-quarantined',
        reason: 'CRDT document is quarantined and no longer accepts writes.',
        retryable: false,
        document: metadata,
      });
    }
    if (
      metadata.quota?.maxUpdateCount !== undefined &&
      metadata.updateCount >= metadata.quota.maxUpdateCount
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'quota-exceeded',
        reason: 'CRDT document update quota is exhausted.',
        retryable: false,
        document: metadata,
      });
    }
    const updateQuotaBytes = byteLengthOfRallarCrdtJson(input.update);
    if (
      metadata.quota?.maxUpdateBytes !== undefined &&
      updateQuotaBytes > metadata.quota.maxUpdateBytes
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'update-too-large',
        reason: 'CRDT update exceeds the document update-byte quota.',
        retryable: false,
        document: metadata,
      });
    }
    if (metadata.quota?.maxDocumentBytes !== undefined) {
      const storedBytes = await readStoredDocumentBytes(tx, documentKey);
      if (
        storedBytes.totalBytes + updateQuotaBytes >
          metadata.quota.maxDocumentBytes
      ) {
        return this.recordAppendResult(startedAtEpochMs, {
          status: 'rejected',
          update: input.update,
          code: 'quota-exceeded',
          reason: 'CRDT document exceeds the document-byte quota.',
          retryable: false,
          document: metadata,
        });
      }
    }
    if (
      await isRateLimited(
        tx,
        documentKey,
        actorId,
        principalId,
        acceptedAtEpochMs,
        metadata.quota?.maxUpdatesPerMinutePerActor,
      )
    ) {
      return this.recordAppendResult(startedAtEpochMs, {
        status: 'rejected',
        update: input.update,
        code: 'rate-limited',
        reason: 'CRDT document actor update-rate limit is exhausted.',
        retryable: true,
        document: metadata,
      });
    }

    const appendSequence = metadata.lastAppendSequence + 1;
    const serializedUpdate = serializeJson(input.update);
    const storedUpdateBytes = byteLengthOfSerializedJson(serializedUpdate);
    await tx`
            insert into crdt_updates (document_key,
                                      append_sequence,
                                      update_id,
                                      update_envelope,
                                      accepted_update_hash,
                                      actor_id,
                                      principal_id,
                                      session_id,
                                      server_id,
                                      authorization_scope,
                                      accepted_at_ts)
            values (${documentKey},
                    ${appendSequence},
                    ${input.update.updateId},
                    ${serializedUpdate},
                    ${acceptedUpdateHash},
                    ${actorId},
                    ${principalId},
                    ${sessionId},
                    ${serverId},
                    ${input.trusted.authorizationScope},
                    ${toPgDate(acceptedAtEpochMs)})
        `;
    await tx`
            update crdt_documents
            set document_revision    = document_revision + 1,
                last_append_sequence = ${appendSequence},
                update_count         = update_count + 1,
                stored_update_bytes  = stored_update_bytes + ${storedUpdateBytes},
                updated_at_ts        = ${toPgDate(acceptedAtEpochMs)}
            where document_key = ${documentKey}
        `;

    const document = await requireDocumentMetadataByKey(tx, documentKey);
    return this.recordAppendResult(startedAtEpochMs, {
      status: 'accepted',
      update: input.update,
      append: {
        appendSequence,
        acceptedAtEpochMs,
        actorId,
        principalId,
        sessionId,
        serverId,
        authorizationScope: input.trusted.authorizationScope,
        acceptedUpdateHash,
      },
      document,
    });
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

  private recordAppendResult(
    startedAtEpochMs: number,
    result: RallarCrdtAppendResult<TPayload>,
  ): RallarCrdtAppendResult<TPayload> {
    const document = result.update?.document ?? result.document?.document;
    const documentKey = document ? toRallarCrdtDocumentKey(document) : result.document?.documentKey;
    void this.metrics?.record({
      name: 'crdt.server.append.ms',
      value: Math.max(0, this.now() - startedAtEpochMs),
      atEpochMs: this.now(),
      documentKey,
      tags: {
        status: result.status,
      },
    });
    if (result.status === 'rejected') {
      void this.metrics?.record({
        name: 'crdt.server.append.rejected.count',
        value: 1,
        atEpochMs: this.now(),
        documentKey,
        tags: {
          code: result.code,
        },
      });
      this.recordAudit('reject', documentKey, {
        code: result.code,
        retryable: result.retryable,
      });
    } else {
      this.recordAudit('append', documentKey, {
        status: result.status,
        appendSequence: result.append.appendSequence,
      });
    }
    return result;
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

async function ensureDocument(
  sql: PSqlSql,
  document: RallarCrdtDocumentRef,
  nowEpochMs: number,
): Promise<void> {
  await sql`
        insert into crdt_documents (document_key,
                                    application_id,
                                    workspace_id,
                                    document_scope,
                                    document_type,
                                    document_id,
                                    document_ref,
                                    created_at_ts,
                                    updated_at_ts)
        values (${toRallarCrdtDocumentKey(document)},
                ${document.applicationId},
                ${document.workspaceId},
                ${document.scope},
                ${document.documentType},
                ${document.documentId},
                ${serializeJson(document)},
                ${toPgDate(nowEpochMs)},
                ${toPgDate(nowEpochMs)})
        on conflict (document_key) do nothing
    `;
}

async function isRateLimited(
  sql: PSqlSql,
  documentKey: string,
  actorId: string | undefined,
  principalId: string | undefined,
  acceptedAtEpochMs: number,
  maxUpdatesPerMinutePerActor: number | undefined,
): Promise<boolean> {
  if (maxUpdatesPerMinutePerActor === undefined) {
    return false;
  }

  const actorKey = actorId ?? principalId;
  if (!actorKey) {
    return false;
  }

  const rows = await sql<ReadonlyArray<{ count: number | string }>>`
        select count(*) as count
        from crdt_updates
        where document_key = ${documentKey}
          and accepted_at_ts >= ${toPgDate(acceptedAtEpochMs - 60_000)}
          and coalesce(actor_id, principal_id) = ${actorKey}
    `;

  return Number(rows[0]?.count ?? 0) >= maxUpdatesPerMinutePerActor;
}

async function readStoredDocumentBytes(
  sql: PSqlSql,
  documentKey: string,
): Promise<{
  updateBytes: number;
  snapshotBytes: number;
  totalBytes: number;
}> {
  const rows = await sql<
    ReadonlyArray<{
      update_bytes: number | string | null;
      snapshot_bytes: number | string | null;
    }>
  >`
        select stored_update_bytes as update_bytes,
               coalesce((
                   select max(octet_length(snapshot_envelope))
                   from crdt_snapshots
                   where document_key = ${documentKey}
               ), 0) as snapshot_bytes
        from crdt_documents
        where document_key = ${documentKey}
        limit 1
    `;
  const updateBytes = Number(rows[0]?.update_bytes ?? 0);
  const snapshotBytes = Number(rows[0]?.snapshot_bytes ?? 0);
  return {
    updateBytes,
    snapshotBytes,
    totalBytes: updateBytes + snapshotBytes,
  };
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

async function requireDocumentMetadataByKey(
  sql: PSqlSql,
  documentKey: string,
  forUpdate = false,
): Promise<RallarCrdtDocumentMetadata> {
  const metadata = await readDocumentMetadataByKey(
    sql,
    documentKey,
    forUpdate,
  );
  if (!metadata) {
    throw new Error(`Missing CRDT document row: ${documentKey}`);
  }
  return metadata;
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

function toPgDate(timestamp: number): Date {
  if (!Number.isFinite(timestamp)) {
    throw new Error('CRDT timestamp must be finite.');
  }
  return new Date(timestamp);
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

function serializeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('CRDT SQL values must be JSON serializable.');
  }
  return serialized;
}

function byteLengthOfSerializedJson(serialized: string): number {
  return new TextEncoder().encode(serialized).byteLength;
}

function parseNullableJson<T>(value: string | null): T | undefined {
  return value === null ? undefined : (JSON.parse(value) as T);
}
