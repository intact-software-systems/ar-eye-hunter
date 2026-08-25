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
    RallarCrdtWriteSnapshotInput
} from '@shared/crdt/mod.ts';

import type { JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { InMemoryCrdtAdministration } from './in-memory-crdt-administration.ts';
import { InMemoryCrdtAppend } from './in-memory-crdt-append.ts';
import { InMemoryCrdtDocumentStore } from './in-memory-crdt-document-store.ts';

export interface InMemoryRallarCrdtLogRepositoryOptions {
    readonly now?: () => number;
    readonly serverId?: string;
    readonly validation?: RallarCrdtValidationOptions;
    readonly hooks?: RallarCrdtProjectionHooks<RallarCrdtOperationBatch>;
    readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
    readonly metrics?: RallarCrdtMetricsSink;
    readonly audit?: RallarCrdtAuditSink;
}

export class InMemoryRallarCrdtLogRepository
    implements RallarCrdtAdminLogRepository<RallarCrdtOperationBatch, JsonWireValue> {
    private readonly now: () => number;
    private readonly audit: RallarCrdtAuditSink | undefined;
    private readonly appendOwner: InMemoryCrdtAppend<RallarCrdtOperationBatch, JsonWireValue>;
    private readonly administration: InMemoryCrdtAdministration<RallarCrdtOperationBatch, JsonWireValue>;

    constructor(options: InMemoryRallarCrdtLogRepositoryOptions = {}) {
        this.now = options.now ?? Date.now;
        this.audit = options.audit;
        const documents = new InMemoryCrdtDocumentStore<RallarCrdtOperationBatch, JsonWireValue>();
        const policies = options.policies ?? [];

        this.appendOwner = new InMemoryCrdtAppend(
            { documents, recordAudit: this.recordAudit },
            {
                now: this.now,
                serverId: options.serverId,
                validation: options.validation,
                hooks: options.hooks,
                policies,
                metrics: options.metrics
            }
        );
        this.administration = new InMemoryCrdtAdministration(
            { documents, recordAudit: this.recordAudit },
            {
                now: this.now,
                hooks: options.hooks,
                policies
            }
        );
    }

    async append(
        input: RallarCrdtAppendUpdateInput<RallarCrdtOperationBatch>
    ): Promise<RallarCrdtAppendResult<RallarCrdtOperationBatch>> {
        return await this.appendOwner.append(input);
    }

    async appendBatch(
        input: RallarCrdtAppendBatchInput<RallarCrdtOperationBatch>
    ): Promise<RallarCrdtAppendBatchResult<RallarCrdtOperationBatch>> {
        return await this.appendOwner.appendBatch(input);
    }

    async listAfter(
        input: RallarCrdtListUpdatesInput
    ): Promise<RallarCrdtUpdatePage<RallarCrdtOperationBatch>> {
        return await this.administration.listAfter(input);
    }

    async readSnapshot(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtSnapshotEnvelope<JsonWireValue> | undefined> {
        return await this.administration.readSnapshot(document);
    }

    async writeSnapshot(input: RallarCrdtWriteSnapshotInput<JsonWireValue>): Promise<void> {
        await this.administration.writeSnapshot(input);
    }

    async readDocumentMetadata(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtDocumentMetadata | undefined> {
        return await this.administration.readDocumentMetadata(document);
    }

    async updateDocumentLifecycle(
        input: RallarCrdtLifecycleInput
    ): Promise<RallarCrdtDocumentMetadata> {
        return await this.administration.updateDocumentLifecycle(input);
    }

    async listDocuments(
        input: RallarCrdtListDocumentsInput = {}
    ): Promise<RallarCrdtDocumentAdminPage> {
        return await this.administration.listDocuments(input);
    }

    async exportDebugBundle(
        document: RallarCrdtDocumentRef,
        options: InMemoryCrdtAdministration.DebugExportOptions = {}
    ): Promise<RallarCrdtDebugBundle<RallarCrdtOperationBatch>> {
        return await this.administration.exportDebugBundle(document, options);
    }

    async exportBackupBundle(
        document: RallarCrdtDocumentRef,
        options: InMemoryCrdtAdministration.BackupExportOptions = {}
    ): Promise<RallarCrdtBackupBundle<RallarCrdtOperationBatch> | undefined> {
        return await this.administration.exportBackupBundle(document, options);
    }

    async restoreBackupBundle(
        bundle: RallarCrdtBackupBundle<RallarCrdtOperationBatch>,
        options: InMemoryCrdtAdministration.RestoreOptions = {}
    ): Promise<RallarCrdtRestoreResult> {
        return await this.administration.restoreBackupBundle(bundle, options);
    }

    async verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport> {
        return await this.administration.verifyIntegrity(document);
    }

    async rebuildProjection(
        document: RallarCrdtDocumentRef,
        projectionId = 'default'
    ): Promise<RallarCrdtIntegrityReport> {
        return await this.administration.rebuildProjection(document, projectionId);
    }

    private readonly recordAudit = (
        kind: RallarCrdtAuditEventKind,
        documentKey: string | undefined,
        metadata?: Readonly<Record<string, string | number | boolean>>
    ): void => {
        void this.audit?.record({
            kind,
            atEpochMs: this.now(),
            documentKey,
            metadata
        });
    };
}
