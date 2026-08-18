import {
  byteLengthOfRallarCrdtJson,
  createRallarCrdtAdminDocumentStatus,
  createRallarCrdtBackupBundle,
  createRallarCrdtDebugBundle,
  fromRallarCrdtAppendCursor,
  type RallarCrdtAuditEventKind,
  type RallarCrdtBackupBundle,
  type RallarCrdtDebugBundle,
  type RallarCrdtDocumentAdminPage,
  type RallarCrdtDocumentMetadata,
  type RallarCrdtDocumentRef,
  type RallarCrdtDocumentTypePolicy,
  type RallarCrdtIntegrityReport,
  type RallarCrdtLifecycleInput,
  type RallarCrdtListDocumentsInput,
  type RallarCrdtListUpdatesInput,
  type RallarCrdtOperationBatch,
  type RallarCrdtProjectionHooks,
  type RallarCrdtRestoreResult,
  type RallarCrdtSnapshotEnvelope,
  type RallarCrdtUpdatePage,
  type RallarCrdtWriteSnapshotInput,
  toRallarCrdtAppendCursor,
  toRallarCrdtDocumentKey,
  validateRallarCrdtSnapshotEnvelope,
  verifyRallarCrdtDebugBundle,
} from '@shared/crdt/mod.ts';

import type { InMemoryCrdtDocumentStore } from './in-memory-crdt-document-store.ts';

export namespace InMemoryCrdtAdministration {
  export interface Dependencies<TPayload extends RallarCrdtOperationBatch, TValue> {
    readonly documents: InMemoryCrdtDocumentStore<TPayload, TValue>;
    readonly recordAudit: (
      kind: RallarCrdtAuditEventKind,
      documentKey: string | undefined,
      metadata?: Readonly<Record<string, string | number | boolean>>,
    ) => void;
  }

  export interface Config<TPayload extends RallarCrdtOperationBatch> {
    readonly now: () => number;
    readonly hooks: RallarCrdtProjectionHooks<TPayload> | undefined;
    readonly policies: readonly RallarCrdtDocumentTypePolicy[];
  }

  export interface DebugExportOptions {
    readonly reason?: string;
    readonly exportedAtEpochMs?: number;
    readonly redaction?: Parameters<typeof createRallarCrdtDebugBundle>[0]['redaction'];
  }

  export interface BackupExportOptions {
    readonly exportedAtEpochMs?: number;
  }

  export interface RestoreOptions {
    readonly overwrite?: boolean;
  }
}

export class InMemoryCrdtAdministration<TPayload extends RallarCrdtOperationBatch, TValue> {
  private readonly documents: InMemoryCrdtDocumentStore<TPayload, TValue>;
  private readonly recordAudit: InMemoryCrdtAdministration.Dependencies<
    TPayload,
    TValue
  >['recordAudit'];
  private readonly config: InMemoryCrdtAdministration.Config<TPayload>;

  constructor(
    dependencies: InMemoryCrdtAdministration.Dependencies<TPayload, TValue>,
    config: InMemoryCrdtAdministration.Config<TPayload>,
  ) {
    this.documents = dependencies.documents;
    this.recordAudit = dependencies.recordAudit;
    this.config = config;
  }

  async listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage<TPayload>> {
    const state = this.documents.get(input.document);
    const afterSequence = input.afterSequence ?? fromRallarCrdtAppendCursor(input.afterCursor) ?? 0;
    const limit = Math.max(0, input.limit ?? 100);
    const allRecords =
      state?.records.filter((record) => record.append.appendSequence > afterSequence) ?? [];
    const records = allRecords.slice(0, limit);
    const lastSequence = records.at(-1)?.append.appendSequence;

    return {
      document: input.document,
      records,
      firstSequence: records[0]?.append.appendSequence,
      lastSequence,
      nextCursor: lastSequence !== undefined ? toRallarCrdtAppendCursor(lastSequence) : undefined,
      hasMore: records.length < allRecords.length,
    };
  }

  async readSnapshot(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined> {
    return this.documents.get(document)?.snapshot;
  }

  async writeSnapshot(input: RallarCrdtWriteSnapshotInput<TValue>): Promise<void> {
    const validation = validateRallarCrdtSnapshotEnvelope(input.snapshot);
    if (!validation.valid) {
      throw new Error('CRDT snapshot envelope failed validation.');
    }

    const state = this.documents.getOrCreate(input.snapshot.document, this.config.now());
    if (
      state.metadata.quota?.maxDocumentBytes !== undefined &&
      byteLengthOfRallarCrdtJson({
        snapshot: input.snapshot,
        updates: state.records.map((record) => record.update),
      }) > state.metadata.quota.maxDocumentBytes
    ) {
      throw new Error('CRDT snapshot exceeds the document-byte quota.');
    }

    this.documents.set({
      ...state,
      metadata: {
        ...state.metadata,
        documentRevision: state.metadata.documentRevision + 1,
        updatedAtEpochMs: input.snapshot.createdAtEpochMs,
        snapshotCount: state.metadata.snapshotCount + 1,
      },
      snapshot: input.snapshot,
    });
    if (input.reason?.includes('compact')) {
      this.recordAudit('compact', state.metadata.documentKey, {
        appendSequence: input.appendSequence,
        reason: input.reason,
      });
    }
  }

  async readDocumentMetadata(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDocumentMetadata | undefined> {
    return this.documents.get(document)?.metadata;
  }

  async updateDocumentLifecycle(
    input: RallarCrdtLifecycleInput,
  ): Promise<RallarCrdtDocumentMetadata> {
    const state = this.documents.getOrCreate(input.document, this.config.now());
    const previousLifecycle = state.metadata.lifecycle;
    const changedAtEpochMs = input.changedAtEpochMs ?? this.config.now();
    const metadata: RallarCrdtDocumentMetadata = {
      ...state.metadata,
      documentRevision: state.metadata.documentRevision + 1,
      lifecycle: input.lifecycle,
      updatedAtEpochMs: changedAtEpochMs,
      archivedAtEpochMs:
        input.lifecycle === 'archived' ? changedAtEpochMs : state.metadata.archivedAtEpochMs,
      destroyedAtEpochMs:
        input.lifecycle === 'destroyed' ? changedAtEpochMs : state.metadata.destroyedAtEpochMs,
      retention: input.retention ?? state.metadata.retention,
      quota: input.quota ?? state.metadata.quota,
      projectionIds: input.projectionIds ?? state.metadata.projectionIds,
    };
    this.documents.set({ ...state, metadata });

    await this.config.hooks?.onLifecycleChanged?.(metadata);
    const auditKind = toLifecycleAuditKind(input.lifecycle, previousLifecycle);
    if (auditKind) {
      this.recordAudit(auditKind, metadata.documentKey, { lifecycle: input.lifecycle });
    }
    return metadata;
  }

  async listDocuments(
    input: RallarCrdtListDocumentsInput = {},
  ): Promise<RallarCrdtDocumentAdminPage> {
    const limit = Math.max(0, input.limit ?? 100);
    const documents = Array.from(this.documents.entries())
      .map(([, state]) => state.metadata)
      .filter((metadata) => matchesDocumentListInput(metadata, input))
      .sort((left, right) => left.documentKey.localeCompare(right.documentKey));
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
    options: InMemoryCrdtAdministration.DebugExportOptions = {},
  ): Promise<RallarCrdtDebugBundle<TPayload>> {
    const state = this.documents.getOrCreate(document, this.config.now());
    const redacted = options.redaction?.payloadsRedacted ?? false;
    this.recordAudit('export', state.metadata.documentKey, {
      reason: options.reason ?? 'operator-export',
      redacted,
    });
    return createRallarCrdtDebugBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.config.now(),
      reason: options.reason ?? 'operator-export',
      document,
      metadata: state.metadata,
      snapshot: state.snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records: state.records,
      redaction: options.redaction,
    });
  }

  async exportBackupBundle(
    document: RallarCrdtDocumentRef,
    options: InMemoryCrdtAdministration.BackupExportOptions = {},
  ): Promise<RallarCrdtBackupBundle<TPayload> | undefined> {
    const state = this.documents.get(document);
    if (!state) {
      return undefined;
    }

    this.recordAudit('backup', state.metadata.documentKey);
    return createRallarCrdtBackupBundle({
      exportedAtEpochMs: options.exportedAtEpochMs ?? this.config.now(),
      document,
      metadata: state.metadata,
      snapshot: state.snapshot as RallarCrdtSnapshotEnvelope | undefined,
      records: state.records,
    });
  }

  async restoreBackupBundle(
    bundle: RallarCrdtBackupBundle<TPayload>,
    options: InMemoryCrdtAdministration.RestoreOptions = {},
  ): Promise<RallarCrdtRestoreResult> {
    const report = verifyRallarCrdtDebugBundle(bundle);
    if (!report.valid) {
      throw new Error(
        `CRDT backup bundle failed integrity verification: ${report.issues[0]?.message}`,
      );
    }

    const existing = this.documents.getByKey(bundle.documentKey);
    if (existing && !options.overwrite) {
      throw new Error(`CRDT document already exists: ${bundle.documentKey}`);
    }

    this.documents.set({
      metadata: bundle.metadata,
      records: [...bundle.records],
      snapshot: bundle.snapshot as RallarCrdtSnapshotEnvelope<TValue> | undefined,
    });
    this.recordAudit('restore', bundle.documentKey, {
      updateCount: bundle.records.length,
      overwrite: options.overwrite === true,
    });

    return {
      document: bundle.document,
      documentKey: bundle.documentKey,
      restoredUpdateCount: bundle.records.length,
      restoredSnapshot: bundle.snapshot !== undefined,
      firstAppendSequence: bundle.integrity.firstAppendSequence,
      lastAppendSequence: bundle.integrity.lastAppendSequence,
    };
  }

  async verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport> {
    return verifyRallarCrdtDebugBundle(
      await this.exportDebugBundle(document, { reason: 'integrity-check' }),
    );
  }

  async rebuildProjection(
    document: RallarCrdtDocumentRef,
    projectionId = 'default',
  ): Promise<RallarCrdtIntegrityReport> {
    const report = await this.verifyIntegrity(document);
    if (report.valid) {
      await this.config.hooks?.rebuild?.(document);
      await this.updateDocumentLifecycle({
        document,
        lifecycle: 'active',
        projectionIds: [projectionId],
      });
      this.recordAudit('rebuild', toRallarCrdtDocumentKey(document), { projectionId });
    }
    return report;
  }

  private rolloutFor(document: RallarCrdtDocumentRef) {
    return (
      this.config.policies.find(
        (policy) =>
          (policy.documentType === '*' || policy.documentType === document.documentType) &&
          (policy.scope === undefined ||
            policy.scope === 'any' ||
            policy.scope === document.scope) &&
          (policy.applicationId === undefined || policy.applicationId === document.applicationId) &&
          (policy.workspaceId === undefined || policy.workspaceId === document.workspaceId),
      )?.rollout ?? 'production'
    );
  }
}

function toLifecycleAuditKind(
  lifecycle: RallarCrdtDocumentMetadata['lifecycle'],
  previousLifecycle: RallarCrdtDocumentMetadata['lifecycle'],
): RallarCrdtAuditEventKind | undefined {
  switch (lifecycle) {
    case 'archived':
      return 'archive';
    case 'quarantined':
      return 'quarantine';
    case 'destroyed':
      return 'destroy';
    case 'active':
      return previousLifecycle === 'active' ? undefined : 'restore';
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
