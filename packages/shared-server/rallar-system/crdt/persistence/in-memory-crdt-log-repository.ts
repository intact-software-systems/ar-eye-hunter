import type {
  RallarCrdtAdminLogRepository,
  RallarCrdtAppendBatchInput,
  RallarCrdtAppendBatchResult,
  RallarCrdtAppendResult,
  RallarCrdtAppendUpdateInput,
  RallarCrdtAuditEventKind,
  RallarCrdtAuditSink,
  RallarCrdtBackupBundle,
  RallarCrdtDebugBundle,
  RallarCrdtDocumentAdminPage,
  RallarCrdtDocumentMetadata,
  RallarCrdtDocumentRef,
  RallarCrdtDocumentTypePolicy,
  RallarCrdtIntegrityReport,
  RallarCrdtLifecycleInput,
  RallarCrdtListDocumentsInput,
  RallarCrdtListUpdatesInput,
  RallarCrdtMetricsSink,
  RallarCrdtOperationBatch,
  RallarCrdtProjectionHooks,
  RallarCrdtRestoreResult,
  RallarCrdtSnapshotEnvelope,
  RallarCrdtUpdatePage,
  RallarCrdtValidationOptions,
  RallarCrdtWriteSnapshotInput,
} from '@shared/crdt/mod.ts';

import { InMemoryCrdtAdministration } from './in-memory-crdt-administration.ts';
import { InMemoryCrdtAppend } from './in-memory-crdt-append.ts';
import { InMemoryCrdtDocumentStore } from './in-memory-crdt-document-store.ts';

export interface InMemoryRallarCrdtLogRepositoryOptions<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> {
  readonly now?: () => number;
  readonly serverId?: string;
  readonly validation?: RallarCrdtValidationOptions;
  readonly hooks?: RallarCrdtProjectionHooks<TPayload>;
  readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
  readonly metrics?: RallarCrdtMetricsSink;
  readonly audit?: RallarCrdtAuditSink;
}

export class InMemoryRallarCrdtLogRepository<
  TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
  TValue = unknown,
> implements RallarCrdtAdminLogRepository<TPayload, TValue> {
  private readonly now: () => number;
  private readonly audit: RallarCrdtAuditSink | undefined;
  private readonly appendOwner: InMemoryCrdtAppend<TPayload, TValue>;
  private readonly administration: InMemoryCrdtAdministration<TPayload, TValue>;

  constructor(options: InMemoryRallarCrdtLogRepositoryOptions<TPayload> = {}) {
    this.now = options.now ?? Date.now;
    this.audit = options.audit;
    const documents = new InMemoryCrdtDocumentStore<TPayload, TValue>();
    const policies = options.policies ?? [];

    this.appendOwner = new InMemoryCrdtAppend(
      { documents, recordAudit: this.recordAudit },
      {
        now: this.now,
        serverId: options.serverId,
        validation: options.validation,
        hooks: options.hooks,
        policies,
        metrics: options.metrics,
      },
    );
    this.administration = new InMemoryCrdtAdministration(
      { documents, recordAudit: this.recordAudit },
      {
        now: this.now,
        hooks: options.hooks,
        policies,
      },
    );
  }

  async append(
    input: RallarCrdtAppendUpdateInput<TPayload>,
  ): Promise<RallarCrdtAppendResult<TPayload>> {
    return await this.appendOwner.append(input);
  }

  async appendBatch(
    input: RallarCrdtAppendBatchInput<TPayload>,
  ): Promise<RallarCrdtAppendBatchResult<TPayload>> {
    return await this.appendOwner.appendBatch(input);
  }

  async listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage<TPayload>> {
    return await this.administration.listAfter(input);
  }

  async readSnapshot(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined> {
    return await this.administration.readSnapshot(document);
  }

  async writeSnapshot(input: RallarCrdtWriteSnapshotInput<TValue>): Promise<void> {
    await this.administration.writeSnapshot(input);
  }

  async readDocumentMetadata(
    document: RallarCrdtDocumentRef,
  ): Promise<RallarCrdtDocumentMetadata | undefined> {
    return await this.administration.readDocumentMetadata(document);
  }

  async updateDocumentLifecycle(
    input: RallarCrdtLifecycleInput,
  ): Promise<RallarCrdtDocumentMetadata> {
    return await this.administration.updateDocumentLifecycle(input);
  }

  async listDocuments(
    input: RallarCrdtListDocumentsInput = {},
  ): Promise<RallarCrdtDocumentAdminPage> {
    return await this.administration.listDocuments(input);
  }

  async exportDebugBundle(
    document: RallarCrdtDocumentRef,
    options: InMemoryCrdtAdministration.DebugExportOptions = {},
  ): Promise<RallarCrdtDebugBundle<TPayload>> {
    return await this.administration.exportDebugBundle(document, options);
  }

  async exportBackupBundle(
    document: RallarCrdtDocumentRef,
    options: InMemoryCrdtAdministration.BackupExportOptions = {},
  ): Promise<RallarCrdtBackupBundle<TPayload> | undefined> {
    return await this.administration.exportBackupBundle(document, options);
  }

  async restoreBackupBundle(
    bundle: RallarCrdtBackupBundle<TPayload>,
    options: InMemoryCrdtAdministration.RestoreOptions = {},
  ): Promise<RallarCrdtRestoreResult> {
    return await this.administration.restoreBackupBundle(bundle, options);
  }

  async verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport> {
    return await this.administration.verifyIntegrity(document);
  }

  async rebuildProjection(
    document: RallarCrdtDocumentRef,
    projectionId = 'default',
  ): Promise<RallarCrdtIntegrityReport> {
    return await this.administration.rebuildProjection(document, projectionId);
  }

  private readonly recordAudit = (
    kind: RallarCrdtAuditEventKind,
    documentKey: string | undefined,
    metadata?: Readonly<Record<string, string | number | boolean>>,
  ): void => {
    void this.audit?.record({
      kind,
      atEpochMs: this.now(),
      documentKey,
      metadata,
    });
  };
}
