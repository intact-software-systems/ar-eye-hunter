import type { RallarCrdtDocument, RallarCrdtUndoRedoGroupInput } from '@shared-web/browser/rallar-crdt.ts';
import type {
    RallarCrdtDocumentHealth,
    RallarCrdtDocumentRef,
    RallarCrdtOperationBatch,
    RallarCrdtSyncOptions,
    RallarCrdtSyncResult,
    RallarCrdtUpdateEnvelope
} from '@shared/crdt/crdt-types.ts';

export namespace CrdtDocumentTestDouble {
    export interface Value {
        readonly title: string;
        readonly applied?: RallarCrdtOperationBatch;
        readonly undone?: RallarCrdtUndoRedoGroupInput;
        readonly redone?: RallarCrdtUndoRedoGroupInput;
    }

    export interface Config {
        readonly documentId: string;
        readonly initialValue: Value;
        readonly applyCompletion?: Promise<void>;
        readonly syncCompletion?: Promise<void>;
        readonly closeCompletion?: Promise<void>;
        readonly destroyCompletion?: Promise<void>;
    }

    export type OperationStatus = 'in-flight' | 'completed';

    export interface ApplicationRecord {
        readonly batch: RallarCrdtOperationBatch;
        status: OperationStatus;
        updateId?: string;
    }

    export interface SynchronizationRecord {
        readonly options: RallarCrdtSyncOptions;
        status: OperationStatus;
        result?: RallarCrdtSyncResult;
    }

    export type LifecycleStatus = 'not-started' | 'in-flight' | 'completed';

    export interface LifecycleRecord {
        invocations: number;
        status: LifecycleStatus;
    }

    export interface Records {
        readonly applications: readonly ApplicationRecord[];
        readonly synchronizations: readonly SynchronizationRecord[];
        readonly close: LifecycleRecord;
        readonly destroy: LifecycleRecord;
    }
}

export class CrdtDocumentTestDouble implements RallarCrdtDocument<CrdtDocumentTestDouble.Value> {
    public readonly ref: RallarCrdtDocumentRef;
    public readonly records: CrdtDocumentTestDouble.Records;

    private readonly applications: CrdtDocumentTestDouble.ApplicationRecord[] = [];
    private readonly synchronizations: CrdtDocumentTestDouble.SynchronizationRecord[] = [];
    private readonly closeRecord: CrdtDocumentTestDouble.LifecycleRecord = {
        invocations: 0,
        status: 'not-started'
    };
    private readonly destroyRecord: CrdtDocumentTestDouble.LifecycleRecord = {
        invocations: 0,
        status: 'not-started'
    };
    private readonly applyCompletion: Promise<void> | undefined;
    private readonly syncCompletion: Promise<void> | undefined;
    private readonly closeCompletion: Promise<void> | undefined;
    private readonly destroyCompletion: Promise<void> | undefined;
    private value: CrdtDocumentTestDouble.Value;
    private lamport = 0;

    public constructor(config: CrdtDocumentTestDouble.Config) {
        this.ref = {
            applicationId: 'test-application',
            workspaceId: 'test-workspace',
            scope: 'app',
            documentType: 'checklist',
            documentId: config.documentId
        };
        this.value = config.initialValue;
        this.applyCompletion = config.applyCompletion;
        this.syncCompletion = config.syncCompletion;
        this.closeCompletion = config.closeCompletion;
        this.destroyCompletion = config.destroyCompletion;
        this.records = {
            applications: this.applications,
            synchronizations: this.synchronizations,
            close: this.closeRecord,
            destroy: this.destroyRecord
        };
    }

    public read(): CrdtDocumentTestDouble.Value {
        return this.value;
    }

    public subscribe(): never {
        throw new Error('CrdtDocumentTestDouble does not support subscriptions.');
    }

    public async applyLocal(
        batch: RallarCrdtOperationBatch
    ): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
        const application: CrdtDocumentTestDouble.ApplicationRecord = {
            batch,
            status: 'in-flight'
        };
        this.applications.push(application);

        if (this.applyCompletion) {
            await this.applyCompletion;
        }

        const update = this.createUpdate('update-apply-' + this.applications.length, batch);
        this.value = {
            ...this.value,
            applied: batch
        };
        application.status = 'completed';
        application.updateId = update.updateId;
        return update;
    }

    public sequenceInsert(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support sequence insertion.'));
    }

    public sequenceMove(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support sequence movement.'));
    }

    public sequenceDelete(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support sequence deletion.'));
    }

    public counterAdd(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support counter addition.'));
    }

    public counterIncrement(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support counter increments.'));
    }

    public counterDecrement(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support counter decrements.'));
    }

    public numberMin(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support minimum-number merges.'));
    }

    public numberMax(): Promise<never> {
        return Promise.reject(new Error('CrdtDocumentTestDouble does not support maximum-number merges.'));
    }

    public operationGroupUpdateIds(): never {
        throw new Error('CrdtDocumentTestDouble does not expose operation-group update IDs.');
    }

    public async undoOperationGroup(
        undo: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
        const batch: RallarCrdtOperationBatch = {
            kind: 'batch',
            operations: undo.operations,
            ...(undo.operationGroupId ? { operationGroupId: undo.operationGroupId } : {})
        };
        const update = this.createUpdate('update-undo-1', batch);
        this.value = {
            ...this.value,
            undone: undo
        };
        return update;
    }

    public async redoOperationGroup(
        redo: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
        const batch: RallarCrdtOperationBatch = {
            kind: 'batch',
            operations: redo.operations,
            ...(redo.operationGroupId ? { operationGroupId: redo.operationGroupId } : {})
        };
        const update = this.createUpdate('update-redo-1', batch);
        this.value = {
            ...this.value,
            redone: redo
        };
        return update;
    }

    public pendingUpdates(): readonly RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>[] {
        return [];
    }

    public failedPendingUpdates(): readonly [] {
        return [];
    }

    public dependencyBlockedUpdates(): readonly [] {
        return [];
    }

    public snapshot(): never {
        throw new Error('CrdtDocumentTestDouble does not expose snapshots.');
    }

    public async flush(): Promise<never> {
        throw new Error('CrdtDocumentTestDouble does not support flush.');
    }

    public async sync(options: RallarCrdtSyncOptions = {}): Promise<RallarCrdtSyncResult> {
        const synchronization: CrdtDocumentTestDouble.SynchronizationRecord = {
            options,
            status: 'in-flight'
        };
        this.synchronizations.push(synchronization);

        if (this.syncCompletion) {
            await this.syncCompletion;
        }

        const result: RallarCrdtSyncResult = {
            status: 'synced',
            transport: options.transport ?? 'local-only',
            sentUpdateCount: 0,
            receivedUpdateCount: 0,
            pendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0
        };
        synchronization.status = 'completed';
        synchronization.result = result;
        return result;
    }

    public async close(): Promise<void> {
        this.closeRecord.invocations += 1;
        this.closeRecord.status = 'in-flight';
        if (this.closeCompletion) {
            await this.closeCompletion;
        }
        this.closeRecord.status = 'completed';
    }

    public async destroy(): Promise<void> {
        this.destroyRecord.invocations += 1;
        this.destroyRecord.status = 'in-flight';
        if (this.destroyCompletion) {
            await this.destroyCompletion;
        }
        this.destroyRecord.status = 'completed';
    }

    public health(): RallarCrdtDocumentHealth {
        return {
            replicaId: 'test-replica',
            pendingUpdateCount: 0,
            failedPendingUpdateCount: 0,
            dependencyBlockedUpdateCount: 0,
            seenUpdateCount: 0,
            transportStrategy: 'local-only'
        };
    }

    private createUpdate(
        updateId: string,
        batch: RallarCrdtOperationBatch
    ): RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch> {
        this.lamport += 1;
        return {
            protocolVersion: 1,
            document: this.ref,
            updateId,
            replicaId: 'test-replica',
            lamport: this.lamport,
            parents: [],
            schemaVersion: 1,
            operationVersion: 1,
            createdAtEpochMs: this.lamport,
            payload: batch
        };
    }
}
