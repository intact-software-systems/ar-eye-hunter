import { BrowserCrdtDocumentPersistence } from '@shared-web/browser/crdt/browser-crdt-document-persistence.ts';
import { BrowserCrdtLiveSync } from '@shared-web/browser/crdt/browser-crdt-live-sync.ts';
import { BrowserCrdtOperationAuthor } from '@shared-web/browser/crdt/browser-crdt-operation-author.ts';
import { sortBrowserCrdtUpdates } from '@shared-web/browser/crdt/browser-crdt-runtime-values.ts';
import { createRallarCrdtTabSync, type RallarCrdtTabSync } from '@shared-web/browser/crdt/browser-crdt-tab-sync.ts';
import type { RallarCrdtMessageTransport } from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type {
    RallarCrdtCounterAddInput,
    RallarCrdtDocument,
    RallarCrdtHttpCatchUpClient,
    RallarCrdtNumberMergeInput,
    RallarCrdtNumericMutationOptions,
    RallarCrdtSequenceDeleteInput,
    RallarCrdtSequenceInsertInput,
    RallarCrdtSequenceMoveInput,
    RallarCrdtSequenceMutationOptions,
    RallarCrdtSnapshotListener,
    RallarCrdtUndoRedoGroupInput
} from '@shared-web/browser/crdt/rallar-crdt-contracts.ts';
import type { RallarDataFacade, RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';
import {
    createRallarCrdtDocument,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDocument as RallarCrdtEngineDocument,
    type RallarCrdtDocumentHealth,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtEncryptionKeyring,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtMetricsSink,
    type RallarCrdtOperationBatch,
    type RallarCrdtPath,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtSyncOptions,
    type RallarCrdtSyncResult,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope,
    type RallarCrdtValidationOptions
} from '@shared/crdt/mod.ts';

export namespace BrowserRallarCrdtDocument {
    export type Options<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
        ref: RallarCrdtDocumentRef;
        documentKey: string;
        replicaId: string;
        actorId?: string;
        sessionId?: string;
        schemaVersion: number;
        initialValue?: TValue;
        persist: boolean;
        tabSync: boolean;
        transport: RallarCrdtTransportStrategy;
        policies: readonly RallarCrdtDocumentTypePolicy[];
        metrics?: RallarCrdtMetricsSink;
        encryption?: RallarCrdtEncryptionKeyring;
        validation?: RallarCrdtValidationOptions;
        durableCatchUp?: RallarCrdtHttpCatchUpClient<TPayload>;
        data: RallarDataFacade;
        dbName: string;
        readTransport?: () => RallarCrdtMessageTransport | undefined;
        now: () => number;
    }>;
}

export class BrowserRallarCrdtDocument<TValue, TPayload extends RallarCrdtOperationBatch>
    implements RallarCrdtDocument<TValue, TPayload> {
    public readonly ref: RallarCrdtDocumentRef;

    private readonly engine: RallarCrdtEngineDocument<TValue, TPayload>;
    private readonly listeners = new Set<RallarCrdtSnapshotListener<TValue>>();
    private readonly pending = new Map<string, RallarCrdtUpdateEnvelope<TPayload>>();
    private readonly failed = new Map<string, RallarCrdtFailedPendingUpdate<TPayload>>();
    private readonly dependencyBlocked = new Map<string, RallarCrdtDependencyBlockedUpdate<TPayload>>();
    private readonly closeListeners = new Set<() => void>();
    private readonly now: () => number;
    private readonly operations: BrowserCrdtOperationAuthor<TPayload>;
    private readonly persistence: BrowserCrdtDocumentPersistence<TValue, TPayload>;
    private readonly liveSync: BrowserCrdtLiveSync<TValue, TPayload>;
    private readonly transport: RallarCrdtTransportStrategy;
    private readonly tabSyncEnabled: boolean;
    private readonly documentKey: string;
    private tabSync: RallarCrdtTabSync<TPayload> | undefined;
    private closed = false;

    public constructor(options: BrowserRallarCrdtDocument.Options<TValue, TPayload>) {
        this.ref = options.ref;
        this.documentKey = options.documentKey;
        this.now = options.now;
        this.transport = options.transport;
        this.tabSyncEnabled = options.tabSync;
        this.engine = createRallarCrdtDocument<TValue, TPayload>({
            ref: options.ref,
            replicaId: options.replicaId,
            actorId: options.actorId,
            sessionId: options.sessionId,
            schemaVersion: options.schemaVersion,
            initialValue: options.initialValue,
            now: options.now,
            validation: options.validation
        });
        this.operations = new BrowserCrdtOperationAuthor<TPayload>({
            actorId: options.actorId,
            replicaId: this.engine.replicaId
        });
        this.persistence = new BrowserCrdtDocumentPersistence({
            ref: this.ref,
            documentKey: this.documentKey,
            engine: this.engine,
            operations: this.operations,
            pending: this.pending,
            failed: this.failed,
            dependencyBlocked: this.dependencyBlocked,
            enabled: options.persist,
            encryption: options.encryption,
            data: options.data,
            dbName: options.dbName,
            now: this.now
        });
        this.liveSync = new BrowserCrdtLiveSync({
            ref: this.ref,
            documentKey: this.documentKey,
            engine: this.engine,
            operations: this.operations,
            persistence: this.persistence,
            pending: this.pending,
            failed: this.failed,
            dependencyBlocked: this.dependencyBlocked,
            transport: this.transport,
            policies: options.policies,
            metrics: options.metrics,
            durableCatchUp: options.durableCatchUp,
            readTransport: options.readTransport,
            now: this.now,
            onSnapshotChanged: () => {
                this.emitSnapshot();
            }
        });
    }

    public async hydrate(): Promise<void> {
        await this.persistence.hydrate();
        const persistenceHealth = this.persistence.health();
        this.liveSync.recordMetric(
            'crdt.merge.replay.ms',
            persistenceHealth.replayDurationMs
        );
        this.liveSync.recordMetric('crdt.pending.failed.count', this.failed.size);
        this.liveSync.recordMetric(
            'crdt.dependency.blocked.count',
            this.dependencyBlocked.size
        );
        if (this.tabSyncEnabled) {
            this.tabSync = createRallarCrdtTabSync<TPayload>({
                documentKey: this.documentKey,
                instanceId: this.engine.replicaId,
                onUpdate: async (update) => {
                    await this.liveSync.applyRemoteUpdate(update);
                }
            });
        }
        await this.liveSync.start();
    }

    public onClosed(listener: () => void): void {
        this.closeListeners.add(listener);
    }

    public read(): TValue {
        return this.engine.read();
    }

    public subscribe(
        listener: RallarCrdtSnapshotListener<TValue>
    ): RallarUnsubscribe {
        this.listeners.add(listener);
        notifyListener(listener, this.snapshot());
        return () => {
            this.listeners.delete(listener);
        };
    }

    public async applyLocal(
        payload: TPayload
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        this.assertOpen();
        const startedAt = this.now();
        const engineUpdate = this.engine.applyLocal(payload);
        const update = (await this.persistence.protectUpdate(
            engineUpdate
        )) as RallarCrdtUpdateEnvelope<TPayload>;
        this.operations.remember(engineUpdate);
        this.pending.set(update.updateId, update);

        try {
            await this.persistence.appendLocalUpdate(update);
            this.tabSync?.broadcast(update);
            await this.liveSync.sendUpdate(update);
            this.emitSnapshot();
            this.liveSync.recordMetric(
                'crdt.local.apply.ms',
                Math.max(0, this.now() - startedAt)
            );
            this.liveSync.recordMetric('crdt.pending.age.ms', 0, {
                updateId: update.updateId
            });
            return update;
        }
        catch (error) {
            const failed: RallarCrdtFailedPendingUpdate<TPayload> = {
                update,
                failedAtEpochMs: this.now(),
                retryable: true,
                reason: error instanceof Error ? error.message : String(error)
            };
            await this.persistence.rememberFailedUpdate(failed);
            this.liveSync.recordMetric(
                'crdt.pending.failed.count',
                this.failed.size
            );
            throw error;
        }
    }

    public async sequenceInsert(
        input: RallarCrdtSequenceInsertInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.sequenceInsert(input, options));
    }

    public async sequenceMove(
        input: RallarCrdtSequenceMoveInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.sequenceMove(input, options));
    }

    public async sequenceDelete(
        input: RallarCrdtSequenceDeleteInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.sequenceDelete(input, options));
    }

    public async counterAdd(
        input: RallarCrdtCounterAddInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.counterAdd(input, options));
    }

    public async counterIncrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.counterIncrement(path, options));
    }

    public async counterDecrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.counterDecrement(path, options));
    }

    public async numberMin(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.numberMin(input, options));
    }

    public async numberMax(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.numberMax(input, options));
    }

    public operationGroupUpdateIds(
        operationGroupId: string
    ): readonly string[] {
        return this.operations.operationGroupUpdateIds(operationGroupId);
    }

    public async undoOperationGroup(
        input: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.undoOperationGroup(input));
    }

    public async redoOperationGroup(
        input: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(this.operations.redoOperationGroup(input));
    }

    public pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[] {
        return sortBrowserCrdtUpdates(Array.from(this.pending.values()));
    }

    public failedPendingUpdates(): readonly RallarCrdtFailedPendingUpdate<TPayload>[] {
        return Array.from(this.failed.values()).sort((left, right) =>
            left.update.updateId.localeCompare(right.update.updateId)
        );
    }

    public dependencyBlockedUpdates(): readonly RallarCrdtDependencyBlockedUpdate<TPayload>[] {
        return Array.from(this.dependencyBlocked.values()).sort((left, right) =>
            left.update.updateId.localeCompare(right.update.updateId)
        );
    }

    public snapshot(): RallarCrdtSnapshotEnvelope<TValue> {
        return this.engine.snapshot();
    }

    public async flush(): Promise<void> {
        this.assertOpen();
        await this.persistence.flush();
    }

    public async sync(
        options: RallarCrdtSyncOptions = {}
    ): Promise<RallarCrdtSyncResult> {
        return await this.liveSync.sync(options);
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        await this.flush();
        this.tabSync?.close();
        this.tabSync = undefined;
        this.liveSync.close();
        await this.persistence.close();
        this.closed = true;
        for (const listener of this.closeListeners) {
            listener();
        }
        this.closeListeners.clear();
        this.listeners.clear();
    }

    public async destroy(): Promise<void> {
        if (!this.closed) {
            this.tabSync?.close();
            this.tabSync = undefined;
            this.liveSync.close();
        }
        await this.persistence.destroy();
        this.closed = true;
        for (const listener of this.closeListeners) {
            listener();
        }
        this.closeListeners.clear();
        this.listeners.clear();
    }

    public health(): RallarCrdtDocumentHealth {
        const persistenceHealth = this.persistence.health();
        const liveHealth = this.liveSync.health();
        return {
            replicaId: this.engine.replicaId,
            pendingUpdateCount: this.pending.size,
            failedPendingUpdateCount: this.failed.size,
            dependencyBlockedUpdateCount: this.dependencyBlocked.size,
            seenUpdateCount: this.engine.seenUpdateIds().size,
            lastServerAppendSequence: liveHealth.lastServerAppendSequence,
            lastServerAckAtEpochMs: liveHealth.lastServerAckAtEpochMs,
            lastSyncError: liveHealth.lastSyncError,
            snapshotAgeMs: persistenceHealth.lastSnapshotAtEpochMs === undefined
                ? undefined
                : Math.max(
                    0,
                    this.now() - persistenceHealth.lastSnapshotAtEpochMs
                ),
            updateLogLag: this.pending.size,
            replayDurationMs: persistenceHealth.replayDurationMs,
            corruptLocalArtifactCount: persistenceHealth.corruptLocalArtifactCount,
            transportStrategy: this.transport,
            lastLiveTransport: liveHealth.lastLiveTransport,
            lastLiveSendStatus: liveHealth.lastLiveSendStatus,
            liveSentUpdateCount: liveHealth.liveSentUpdateCount,
            liveReceivedUpdateCount: liveHealth.liveReceivedUpdateCount,
            liveDuplicateUpdateCount: liveHealth.liveDuplicateUpdateCount,
            liveRejectedUpdateCount: liveHealth.liveRejectedUpdateCount,
            liveDependencyBlockedUpdateCount: liveHealth.liveDependencyBlockedUpdateCount,
            liveRetriedUpdateCount: liveHealth.liveRetriedUpdateCount,
            liveSyncRequestCount: liveHealth.liveSyncRequestCount,
            liveSyncResponseCount: liveHealth.liveSyncResponseCount
        };
    }

    private emitSnapshot(): void {
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            notifyListener(listener, snapshot);
        }
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('CRDT document is closed.');
        }
    }
}

function notifyListener<TValue>(
    listener: RallarCrdtSnapshotListener<TValue>,
    snapshot: RallarCrdtSnapshotEnvelope<TValue>
): void {
    void Promise.resolve(listener(snapshot)).catch((error) => {
        console.error('Error notifying CRDT snapshot listener', error);
    });
}
