import {
    createRallarCrdtLocalStore,
    DEFAULT_RALLAR_CRDT_DB_NAME,
    type RallarCrdtLocalStore
} from '@shared-web/browser/crdt/browser-crdt-local-store.ts';
import { createRallarCrdtTabSync, type RallarCrdtTabSync } from '@shared-web/browser/crdt/browser-crdt-tab-sync.ts';
import {
    sendRallarCrdtCatchUpRequest,
    sendRallarCrdtLiveUpdate,
    sendRallarCrdtSyncRequest,
    sendRallarCrdtSyncResponse,
    subscribeRallarCrdtLiveTransport,
    type RallarCrdtMessageTransport,
    type RallarCrdtTransportKind
} from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type { RallarDataFacade, RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarCrdtDocument,
    decryptRallarCrdtSnapshotEnvelope,
    decryptRallarCrdtUpdateEnvelope,
    encryptRallarCrdtSnapshotEnvelope,
    encryptRallarCrdtUpdateEnvelope,
    isRallarCrdtEncryptedJsonEnvelope,
    isRallarCrdtEncryptedOperationBatch,
    RALLAR_CRDT_PROTOCOL_VERSION,
    rallarCrdtBatch,
    toRallarCrdtDocumentKey,
    type RallarCrdtAppendResponseEnvelope,
    type RallarCrdtApplyResult,
    type RallarCrdtCatchUpRequestEnvelope,
    type RallarCrdtCatchUpResponseEnvelope,
    type RallarCrdtDependencyBlockedUpdate,
    type RallarCrdtDocument as RallarCrdtEngineDocument,
    type RallarCrdtDocumentHealth,
    type RallarCrdtDocumentRef,
    type RallarCrdtDocumentTypePolicy,
    type RallarCrdtEncryptionKeyring,
    type RallarCrdtFailedPendingUpdate,
    type RallarCrdtJsonValue,
    type RallarCrdtMetricsSink,
    type RallarCrdtOperation,
    type RallarCrdtOperationBatch,
    type RallarCrdtPath,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtSyncOptions,
    type RallarCrdtSyncRequestEnvelope,
    type RallarCrdtSyncResponseEnvelope,
    type RallarCrdtSyncResult,
    type RallarCrdtTransportStrategy,
    type RallarCrdtUpdateEnvelope,
    type RallarCrdtValidationOptions
} from '@shared/crdt/mod.ts';

export type RallarCrdtSnapshotListener<TValue> = (
    snapshot: RallarCrdtSnapshotEnvelope<TValue>
) => void | Promise<void>;

export type RallarCrdtOpenScope =
    | Readonly<{ kind: 'app'; }>
    | Readonly<{ kind: 'principal'; principalId: string; }>
    | Readonly<{ kind: 'room'; roomRef: GroupRef; }>
    | Readonly<{ kind: 'custom'; customScope: string; }>;

export type RallarCrdtOpenOptions<
    TValue = unknown,
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> = Readonly<{
    applicationId?: string;
    workspaceId?: string;
    documentId?: string;
    documentType?: string;
    scope?: RallarCrdtOpenScope;
    transport?: RallarCrdtTransportStrategy;
    persist?: boolean;
    tabSync?: boolean;
    dbName?: string;
    replicaId?: string;
    actorId?: string;
    sessionId?: string;
    schemaVersion?: number;
    initialValue?: TValue;
    policies?: readonly RallarCrdtDocumentTypePolicy[];
    metrics?: RallarCrdtMetricsSink;
    encryption?: RallarCrdtEncryptionKeyring;
    validation?: RallarCrdtValidationOptions;
    durableCatchUp?: RallarCrdtHttpCatchUpClient<TPayload>;
}>;

export type RallarCrdtFacadeDefaults = Readonly<{
    applicationId?: string;
    workspaceId?: string;
    room?: Readonly<{
        roomRef?: GroupRef;
        roomId?: string;
    }>;
}>;

export type RallarCrdtFacadeOptions = Readonly<{
    data: RallarDataFacade;
    readDefaults?: () => RallarCrdtFacadeDefaults | undefined;
    readTransport?: () => RallarCrdtMessageTransport | undefined;
    readDurableCatchUp?: () => RallarCrdtHttpCatchUpClient | undefined;
    now?: () => number;
    createReplicaId?: () => string;
}>;

export type RallarCrdtHttpCatchUpClient<TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch> = (
    request: RallarCrdtCatchUpRequestEnvelope
) => Promise<RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>>;

export type RallarCrdtDocument<TValue, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch> = Readonly<
    {
        ref: RallarCrdtDocumentRef;
        read(): TValue;
        subscribe(listener: RallarCrdtSnapshotListener<TValue>): RallarUnsubscribe;
        applyLocal(payload: TPayload): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        sequenceInsert(
            input: RallarCrdtSequenceInsertInput,
            options?: RallarCrdtSequenceMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        sequenceMove(
            input: RallarCrdtSequenceMoveInput,
            options?: RallarCrdtSequenceMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        sequenceDelete(
            input: RallarCrdtSequenceDeleteInput,
            options?: RallarCrdtSequenceMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        counterAdd(
            input: RallarCrdtCounterAddInput,
            options?: RallarCrdtNumericMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        counterIncrement(
            path: RallarCrdtPath,
            options?: RallarCrdtNumericMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        counterDecrement(
            path: RallarCrdtPath,
            options?: RallarCrdtNumericMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        numberMin(
            input: RallarCrdtNumberMergeInput,
            options?: RallarCrdtNumericMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        numberMax(
            input: RallarCrdtNumberMergeInput,
            options?: RallarCrdtNumericMutationOptions
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        operationGroupUpdateIds(operationGroupId: string): readonly string[];
        undoOperationGroup(
            input: RallarCrdtUndoRedoGroupInput
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        redoOperationGroup(
            input: RallarCrdtUndoRedoGroupInput
        ): Promise<RallarCrdtUpdateEnvelope<TPayload>>;
        pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[];
        failedPendingUpdates(): readonly RallarCrdtFailedPendingUpdate<TPayload>[];
        dependencyBlockedUpdates(): readonly RallarCrdtDependencyBlockedUpdate<TPayload>[];
        snapshot(): RallarCrdtSnapshotEnvelope<TValue>;
        flush(): Promise<void>;
        sync(options?: RallarCrdtSyncOptions): Promise<RallarCrdtSyncResult>;
        close(): Promise<void>;
        destroy(): Promise<void>;
        health(): RallarCrdtDocumentHealth;
    }
>;

export type RallarCrdtSequenceMutationOptions = Readonly<{
    operationGroupId?: string;
}>;

export type RallarCrdtSequenceInsertInput = Readonly<{
    path: RallarCrdtPath;
    elementId: string;
    positionId: string;
    value: RallarCrdtJsonValue;
}>;

export type RallarCrdtSequenceMoveInput = Readonly<{
    path: RallarCrdtPath;
    elementId: string;
    positionId: string;
    observedUpdateIds: readonly string[];
}>;

export type RallarCrdtSequenceDeleteInput = Readonly<{
    path: RallarCrdtPath;
    elementId: string;
    observedUpdateIds: readonly string[];
}>;

export type RallarCrdtNumericMutationOptions = Readonly<{
    operationGroupId?: string;
}>;

export type RallarCrdtCounterAddInput = Readonly<{
    path: RallarCrdtPath;
    delta: number;
}>;

export type RallarCrdtNumberMergeInput = Readonly<{
    path: RallarCrdtPath;
    value: number;
}>;

export type RallarCrdtUndoRedoGroupInput = Readonly<{
    targetOperationGroupId: string;
    operations: readonly RallarCrdtOperation[];
    operationGroupId?: string;
}>;

export type RallarCrdtFacade = Readonly<{
    open<TValue = unknown, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
        name: string,
        options?: RallarCrdtOpenOptions<TValue, TPayload>
    ): Promise<RallarCrdtDocument<TValue, TPayload>>;
}>;

type BrowserCrdtDocumentOptions<TValue, TPayload extends RallarCrdtOperationBatch> = Readonly<{
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

export function createRallarCrdtFacade(
    options: RallarCrdtFacadeOptions
): RallarCrdtFacade {
    const openDocuments = new Map<string, RallarCrdtDocument<unknown>>();
    const now = options.now ?? Date.now;

    return {
        open: async <TValue = unknown, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
            name: string,
            openOptions: RallarCrdtOpenOptions<TValue, TPayload> = {}
        ): Promise<RallarCrdtDocument<TValue, TPayload>> => {
            const ref = toDocumentRef(
                name,
                openOptions,
                options.readDefaults?.()
            );
            const documentKey = toRallarCrdtDocumentKey(ref);
            const existing = openDocuments.get(documentKey);
            if (existing) {
                return existing as RallarCrdtDocument<TValue, TPayload>;
            }

            const document = new BrowserRallarCrdtDocument<TValue, TPayload>({
                ref,
                documentKey,
                replicaId: openOptions.replicaId ??
                    options.createReplicaId?.() ??
                    createRandomId('replica'),
                actorId: openOptions.actorId,
                sessionId: openOptions.sessionId,
                schemaVersion: openOptions.schemaVersion ?? 1,
                initialValue: openOptions.initialValue,
                persist: openOptions.persist ?? true,
                tabSync: openOptions.tabSync ?? true,
                transport: openOptions.transport ?? 'local-only',
                policies: openOptions.policies ?? [],
                metrics: openOptions.metrics,
                encryption: openOptions.encryption,
                validation: openOptions.validation,
                durableCatchUp: (openOptions.durableCatchUp ??
                    options.readDurableCatchUp?.()) as
                        | RallarCrdtHttpCatchUpClient<TPayload>
                        | undefined,
                data: options.data,
                dbName: openOptions.dbName ?? DEFAULT_RALLAR_CRDT_DB_NAME,
                readTransport: options.readTransport,
                now
            });

            await document.hydrate();
            openDocuments.set(
                documentKey,
                document as RallarCrdtDocument<unknown>
            );
            document.onClosed(() => {
                if (openDocuments.get(documentKey) === document) {
                    openDocuments.delete(documentKey);
                }
            });
            return document;
        }
    };
}

class BrowserRallarCrdtDocument<TValue, TPayload extends RallarCrdtOperationBatch>
    implements RallarCrdtDocument<TValue, TPayload> {
    public readonly ref: RallarCrdtDocumentRef;

    private readonly engine: RallarCrdtEngineDocument<TValue, TPayload>;
    private readonly listeners = new Set<RallarCrdtSnapshotListener<TValue>>();
    private readonly pending = new Map<string, RallarCrdtUpdateEnvelope<TPayload>>();
    private readonly failed = new Map<string, RallarCrdtFailedPendingUpdate<TPayload>>();
    private readonly dependencyBlocked = new Map<string, RallarCrdtDependencyBlockedUpdate<TPayload>>();
    private readonly closeListeners = new Set<() => void>();
    private readonly now: () => number;
    private readonly actorId: string | undefined;
    private readonly persist: boolean;
    private readonly transport: RallarCrdtTransportStrategy;
    private readonly policies: readonly RallarCrdtDocumentTypePolicy[];
    private readonly metrics?: RallarCrdtMetricsSink;
    private readonly encryption: RallarCrdtEncryptionKeyring | undefined;
    private readonly durableCatchUp:
        | RallarCrdtHttpCatchUpClient<TPayload>
        | undefined;
    private readonly tabSyncEnabled: boolean;
    private readonly data: RallarDataFacade;
    private readonly dbName: string;
    private readonly documentKey: string;
    private readonly readTransport:
        | (() => RallarCrdtMessageTransport | undefined)
        | undefined;
    private readonly operationGroups = new Map<string, Set<string>>();

    private localStore: RallarCrdtLocalStore | undefined;
    private tabSync: RallarCrdtTabSync<TPayload> | undefined;
    private liveUnsubscribes: RallarUnsubscribe[] = [];
    private closed = false;
    private lastSnapshotAtEpochMs: number | undefined;
    private lastSyncError: string | undefined;
    private lastLiveTransport: RallarCrdtTransportKind | undefined;
    private lastLiveSendStatus: string | undefined;
    private liveSentUpdateCount = 0;
    private liveReceivedUpdateCount = 0;
    private liveDuplicateUpdateCount = 0;
    private liveRejectedUpdateCount = 0;
    private liveDependencyBlockedUpdateCount = 0;
    private liveRetriedUpdateCount = 0;
    private liveSyncRequestCount = 0;
    private liveSyncResponseCount = 0;
    private replayDurationMs: number | undefined;
    private corruptLocalArtifactCount = 0;
    private lastServerAppendSequence: number | undefined;
    private lastServerAckAtEpochMs: number | undefined;

    public constructor(options: BrowserCrdtDocumentOptions<TValue, TPayload>) {
        this.ref = options.ref;
        this.documentKey = options.documentKey;
        this.now = options.now;
        this.actorId = options.actorId;
        this.persist = options.persist;
        this.transport = options.transport;
        this.policies = options.policies;
        this.metrics = options.metrics;
        this.encryption = options.encryption;
        this.durableCatchUp = options.durableCatchUp;
        this.tabSyncEnabled = options.tabSync;
        this.data = options.data;
        this.dbName = options.dbName;
        this.readTransport = options.readTransport;
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
    }

    public async hydrate(): Promise<void> {
        const startedAt = this.now();
        if (this.persist) {
            this.localStore = await createRallarCrdtLocalStore({
                data: this.data,
                dbName: this.dbName
            });
            const state = await this.localStore.loadDocument<TValue, TPayload>(
                this.ref
            );
            this.corruptLocalArtifactCount = state.corruptArtifacts.length;

            if (state.snapshot) {
                this.engine.importSnapshot(
                    await this.revealSnapshotForMerge(state.snapshot)
                );
                this.lastSnapshotAtEpochMs = state.snapshot.createdAtEpochMs;
            }

            for (const update of sortUpdates(state.pendingUpdates)) {
                this.pending.set(update.updateId, update);
                const engineUpdate = await this.revealUpdateForMerge(update);
                this.engine.apply(engineUpdate);
                this.rememberOperationGroup(engineUpdate);
            }
            for (const failed of state.failedPendingUpdates) {
                this.failed.set(failed.update.updateId, failed);
            }
            for (const blocked of state.dependencyBlockedUpdates) {
                this.dependencyBlocked.set(blocked.update.updateId, blocked);
            }

            await this.localStore.writeMetadata({
                documentKey: this.documentKey,
                ref: this.ref,
                replicaId: this.engine.replicaId,
                schemaVersion: state.metadata?.schemaVersion ?? 1,
                updatedAtEpochMs: this.now()
            });
        }

        this.replayDurationMs = Math.max(0, this.now() - startedAt);
        this.recordMetric('crdt.merge.replay.ms', this.replayDurationMs);
        this.recordMetric('crdt.pending.failed.count', this.failed.size);
        this.recordMetric(
            'crdt.dependency.blocked.count',
            this.dependencyBlocked.size
        );
        if (this.tabSyncEnabled) {
            this.tabSync = createRallarCrdtTabSync<TPayload>({
                documentKey: this.documentKey,
                instanceId: this.engine.replicaId,
                onUpdate: async (update) => {
                    await this.applyRemoteUpdate(update);
                }
            });
        }
        this.subscribeLiveTransport();
        if (!(await this.requestDurableCatchUp('open'))) {
            await this.requestHttpCatchUp('open');
        }
        await this.requestLiveCatchUp('open');
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
        const update = (await this.protectUpdateForStorage(
            engineUpdate
        )) as RallarCrdtUpdateEnvelope<TPayload>;
        this.rememberOperationGroup(engineUpdate);
        this.pending.set(update.updateId, update);

        try {
            await this.localStore?.appendPendingUpdate(update);
            await this.persistAppliedState(update);
            await this.localStore?.flush();
            this.tabSync?.broadcast(update);
            await this.sendLiveUpdate(update);
            this.emitSnapshot();
            this.recordMetric(
                'crdt.local.apply.ms',
                Math.max(0, this.now() - startedAt)
            );
            this.recordMetric('crdt.pending.age.ms', 0, {
                updateId: update.updateId
            });
            return update;
        }
        catch (error) {
            const failed: RallarCrdtFailedPendingUpdate<TPayload> = {
                update,
                failedAtEpochMs: this.now(),
                retryable: true,
                reason: toErrorMessage(error)
            };
            this.failed.set(update.updateId, failed);
            await this.localStore?.writeFailedPendingUpdate(failed);
            this.recordMetric('crdt.pending.failed.count', this.failed.size);
            throw error;
        }
    }

    public async sequenceInsert(
        input: RallarCrdtSequenceInsertInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'sequence.insert',
                        path: input.path,
                        elementId: input.elementId,
                        positionId: input.positionId,
                        value: input.value
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public async sequenceMove(
        input: RallarCrdtSequenceMoveInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'sequence.move',
                        path: input.path,
                        elementId: input.elementId,
                        positionId: input.positionId,
                        observedUpdateIds: input.observedUpdateIds
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public async sequenceDelete(
        input: RallarCrdtSequenceDeleteInput,
        options: RallarCrdtSequenceMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'sequence.delete',
                        path: input.path,
                        elementId: input.elementId,
                        observedUpdateIds: input.observedUpdateIds
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public async counterAdd(
        input: RallarCrdtCounterAddInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'counter.add',
                        path: input.path,
                        delta: input.delta
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public async counterIncrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.counterAdd(
            {
                path,
                delta: 1
            },
            options
        );
    }

    public async counterDecrement(
        path: RallarCrdtPath,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.counterAdd(
            {
                path,
                delta: -1
            },
            options
        );
    }

    public async numberMin(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'number.min',
                        path: input.path,
                        value: input.value
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public async numberMax(
        input: RallarCrdtNumberMergeInput,
        options: RallarCrdtNumericMutationOptions = {}
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        return await this.applyLocal(
            rallarCrdtBatch(
                [
                    {
                        kind: 'number.max',
                        path: input.path,
                        value: input.value
                    }
                ],
                {
                    operationGroupId: options.operationGroupId
                }
            ) as TPayload
        );
    }

    public operationGroupUpdateIds(
        operationGroupId: string
    ): readonly string[] {
        return Array.from(
            this.operationGroups.get(operationGroupId) ?? []
        ).sort();
    }

    public async undoOperationGroup(
        input: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        const targetUpdateIds = this.operationGroupUpdateIds(
            input.targetOperationGroupId
        );
        if (targetUpdateIds.length === 0) {
            throw new Error(
                `Cannot undo unknown CRDT operation group: ${input.targetOperationGroupId}.`
            );
        }
        return await this.applyLocal(
            rallarCrdtBatch(input.operations, {
                operationGroupId: input.operationGroupId ??
                    `undo:${input.targetOperationGroupId}`,
                undo: {
                    actorId: this.actorId ?? this.engine.replicaId,
                    targetOperationGroupId: input.targetOperationGroupId,
                    targetUpdateIds
                }
            }) as TPayload
        );
    }

    public async redoOperationGroup(
        input: RallarCrdtUndoRedoGroupInput
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        const targetUpdateIds = this.operationGroupUpdateIds(
            input.targetOperationGroupId
        );
        if (targetUpdateIds.length === 0) {
            throw new Error(
                `Cannot redo unknown CRDT operation group: ${input.targetOperationGroupId}.`
            );
        }
        return await this.applyLocal(
            rallarCrdtBatch(input.operations, {
                operationGroupId: input.operationGroupId ??
                    `redo:${input.targetOperationGroupId}`,
                redo: {
                    actorId: this.actorId ?? this.engine.replicaId,
                    targetOperationGroupId: input.targetOperationGroupId,
                    targetUpdateIds
                }
            }) as TPayload
        );
    }

    public pendingUpdates(): readonly RallarCrdtUpdateEnvelope<TPayload>[] {
        return sortUpdates(Array.from(this.pending.values()));
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
        if (!this.localStore) {
            return;
        }

        const snapshot = await this.protectSnapshotForStorage(
            this.engine.snapshot('flush')
        );
        await this.localStore.writeSnapshot(snapshot);
        await this.localStore.flush();
        this.lastSnapshotAtEpochMs = snapshot.createdAtEpochMs;
    }

    public async sync(
        options: RallarCrdtSyncOptions = {}
    ): Promise<RallarCrdtSyncResult> {
        const transport = options.transport ?? this.transport;
        if (transport === 'local-only') {
            const result: RallarCrdtSyncResult = {
                status: 'local-only',
                transport,
                sentUpdateCount: 0,
                receivedUpdateCount: 0,
                pendingUpdateCount: this.pending.size,
                dependencyBlockedUpdateCount: this.dependencyBlocked.size,
                reason: options.reason ?? 'Document is opened in local-only mode.'
            };
            this.lastSyncError = undefined;
            this.recordSyncMetrics(result);
            return result;
        }
        const liveTransport = this.readTransport?.();
        if (!liveTransport) {
            const receivedHttpCatchUp = await this.requestHttpCatchUp(
                options.reason ?? 'manual-sync'
            );
            const result: RallarCrdtSyncResult = {
                status: receivedHttpCatchUp ? 'synced' : 'deferred',
                transport,
                sentUpdateCount: 0,
                receivedUpdateCount: 0,
                pendingUpdateCount: this.pending.size,
                dependencyBlockedUpdateCount: this.dependencyBlocked.size,
                reason: receivedHttpCatchUp
                    ? undefined
                    : 'No CRDT live transport is configured.'
            };
            this.lastSyncError = receivedHttpCatchUp
                ? undefined
                : this.lastSyncError;
            this.recordSyncMetrics(result);
            return result;
        }

        let sentUpdateCount = 0;
        let failedCount = 0;
        let deferredReason: string | undefined;

        for (const update of this.pendingUpdates()) {
            this.liveRetriedUpdateCount += 1;
            const outcome = await sendRallarCrdtLiveUpdate({
                update,
                transport: liveTransport,
                strategy: transport,
                policies: this.policies
            });
            sentUpdateCount += outcome.sentCount;
            failedCount += outcome.failedCount;
            deferredReason ??= outcome.reason;
            this.rememberLiveSendOutcome(outcome);
        }
        if (
            !(await this.requestDurableCatchUp(
                options.reason ?? 'manual-sync',
                transport
            ))
        ) {
            await this.requestHttpCatchUp(options.reason ?? 'manual-sync');
        }
        await this.requestLiveCatchUp(
            options.reason ?? 'manual-sync',
            transport
        );

        const status = sentUpdateCount > 0
            ? 'synced'
            : deferredReason
            ? 'deferred'
            : failedCount > 0
            ? 'failed'
            : 'synced';
        const result: RallarCrdtSyncResult = {
            status,
            transport,
            sentUpdateCount,
            receivedUpdateCount: 0,
            pendingUpdateCount: this.pending.size,
            dependencyBlockedUpdateCount: this.dependencyBlocked.size,
            reason: deferredReason,
            error: status === 'failed'
                ? (deferredReason ?? 'CRDT live sync failed.')
                : undefined
        };

        this.lastSyncError = result.status === 'failed' ? result.error : undefined;
        this.recordSyncMetrics(result);
        return result;
    }

    public async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        await this.flush();
        this.tabSync?.close();
        this.tabSync = undefined;
        this.unsubscribeLiveTransport();
        await this.localStore?.close();
        this.localStore = undefined;
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
            this.unsubscribeLiveTransport();
        }
        await this.localStore?.destroyDocument(this.ref);
        await this.localStore?.close();
        this.localStore = undefined;
        this.closed = true;
        for (const listener of this.closeListeners) {
            listener();
        }
        this.closeListeners.clear();
        this.listeners.clear();
    }

    public health(): RallarCrdtDocumentHealth {
        return {
            replicaId: this.engine.replicaId,
            pendingUpdateCount: this.pending.size,
            failedPendingUpdateCount: this.failed.size,
            dependencyBlockedUpdateCount: this.dependencyBlocked.size,
            seenUpdateCount: this.engine.seenUpdateIds().size,
            lastServerAppendSequence: this.lastServerAppendSequence,
            lastServerAckAtEpochMs: this.lastServerAckAtEpochMs,
            lastSyncError: this.lastSyncError,
            snapshotAgeMs: this.lastSnapshotAtEpochMs === undefined
                ? undefined
                : Math.max(0, this.now() - this.lastSnapshotAtEpochMs),
            updateLogLag: this.pending.size,
            replayDurationMs: this.replayDurationMs,
            corruptLocalArtifactCount: this.corruptLocalArtifactCount,
            transportStrategy: this.transport,
            lastLiveTransport: this.lastLiveTransport,
            lastLiveSendStatus: this.lastLiveSendStatus,
            liveSentUpdateCount: this.liveSentUpdateCount,
            liveReceivedUpdateCount: this.liveReceivedUpdateCount,
            liveDuplicateUpdateCount: this.liveDuplicateUpdateCount,
            liveRejectedUpdateCount: this.liveRejectedUpdateCount,
            liveDependencyBlockedUpdateCount: this.liveDependencyBlockedUpdateCount,
            liveRetriedUpdateCount: this.liveRetriedUpdateCount,
            liveSyncRequestCount: this.liveSyncRequestCount,
            liveSyncResponseCount: this.liveSyncResponseCount
        };
    }

    private async applyRemoteUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        transport?: RallarCrdtTransportKind
    ): Promise<void> {
        if (this.closed) {
            return;
        }
        if (toRallarCrdtDocumentKey(update.document) !== this.documentKey) {
            return;
        }

        const engineUpdate = await this.revealUpdateForMerge(update);
        const result = this.engine.apply(engineUpdate);
        this.rememberLiveApplyResult(result, transport);
        if (result.status === 'applied' || result.status === 'duplicate') {
            this.rememberOperationGroup(engineUpdate);
        }
        await this.persistApplyResult(update, result);
        if (result.status === 'applied' || result.status === 'duplicate') {
            this.emitSnapshot();
        }
    }

    private rememberOperationGroup(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): void {
        const operationGroupId = update.payload.operationGroupId;
        if (!operationGroupId) {
            return;
        }
        const updates = this.operationGroups.get(operationGroupId) ?? new Set();
        updates.add(update.updateId);
        this.operationGroups.set(operationGroupId, updates);
    }

    private async persistApplyResult(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        result: RallarCrdtApplyResult
    ): Promise<void> {
        if (!this.localStore) {
            return;
        }

        if (result.status === 'applied' || result.status === 'duplicate') {
            await this.persistAppliedState(update, result.releasedUpdateIds);
            return;
        }

        if (result.status === 'dependency-blocked') {
            const blocked: RallarCrdtDependencyBlockedUpdate<TPayload> = {
                update,
                blockedAtEpochMs: this.now(),
                missingDependencyIds: result.missingDependencyIds,
                reason: 'Missing CRDT update dependencies.'
            };
            this.dependencyBlocked.set(update.updateId, blocked);
            await this.localStore.writeDependencyBlockedUpdate(blocked);
        }
    }

    private async persistAppliedState(
        update: RallarCrdtUpdateEnvelope<TPayload>,
        releasedUpdateIds: readonly string[] = []
    ): Promise<void> {
        if (!this.localStore) {
            return;
        }

        const appliedUpdateIds = [
            ...new Set([update.updateId, ...releasedUpdateIds])
        ];
        await Promise.all(
            appliedUpdateIds.flatMap((updateId) => {
                this.dependencyBlocked.delete(updateId);
                return [
                    this.localStore?.markSeen(this.ref, updateId, this.now()),
                    this.localStore?.removeDependencyBlockedUpdate(
                        this.ref,
                        updateId
                    )
                ];
            })
        );

        const snapshot = await this.protectSnapshotForStorage(
            this.engine.snapshot('applied-update')
        );
        await this.localStore.writeSnapshot(snapshot);
        this.lastSnapshotAtEpochMs = snapshot.createdAtEpochMs;
    }

    private async protectUpdateForStorage(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>> {
        return this.encryption
            ? await encryptRallarCrdtUpdateEnvelope(update, this.encryption)
            : update;
    }

    private async revealUpdateForMerge(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<RallarCrdtUpdateEnvelope<TPayload>> {
        if (!isRallarCrdtEncryptedOperationBatch(update.payload)) {
            return update;
        }
        if (!this.encryption) {
            throw new Error(
                'Cannot apply encrypted CRDT update without document encryption keys.'
            );
        }
        return await decryptRallarCrdtUpdateEnvelope<TPayload>(
            update as RallarCrdtUpdateEnvelope<RallarCrdtOperationBatch>,
            this.encryption
        );
    }

    private async protectSnapshotForStorage(
        snapshot: RallarCrdtSnapshotEnvelope<TValue>
    ): Promise<RallarCrdtSnapshotEnvelope<TValue>> {
        return this.encryption
            ? ((await encryptRallarCrdtSnapshotEnvelope(
                snapshot,
                this.encryption
            )) as RallarCrdtSnapshotEnvelope<TValue>)
            : snapshot;
    }

    private async revealSnapshotForMerge(
        snapshot: RallarCrdtSnapshotEnvelope<TValue>
    ): Promise<RallarCrdtSnapshotEnvelope<TValue>> {
        if (!isRallarCrdtEncryptedJsonEnvelope(snapshot.value)) {
            return snapshot;
        }
        if (!this.encryption) {
            throw new Error(
                'Cannot import encrypted CRDT snapshot without document encryption keys.'
            );
        }
        return await decryptRallarCrdtSnapshotEnvelope<TValue>(
            snapshot,
            this.encryption
        );
    }

    private subscribeLiveTransport(): void {
        this.unsubscribeLiveTransport();
        this.liveUnsubscribes = [
            ...subscribeRallarCrdtLiveTransport<TPayload>({
                ref: this.ref,
                transport: this.readTransport?.(),
                strategy: this.transport,
                policies: this.policies,
                onUpdate: async (update, transport) => {
                    await this.applyRemoteUpdate(update, transport);
                },
                onSyncRequest: async (request, transport) => {
                    await this.handleSyncRequest(request, transport);
                },
                onSyncResponse: async (response, transport) => {
                    await this.handleSyncResponse(response, transport);
                },
                onAppendResponse: async (response) => {
                    await this.handleAppendResponse(response);
                },
                onCatchUpResponse: async (response, transport) => {
                    await this.handleCatchUpResponse(response, transport);
                }
            })
        ];
    }

    private unsubscribeLiveTransport(): void {
        for (const unsubscribe of this.liveUnsubscribes) {
            unsubscribe();
        }
        this.liveUnsubscribes = [];
    }

    private async sendLiveUpdate(
        update: RallarCrdtUpdateEnvelope<TPayload>
    ): Promise<void> {
        const outcome = await sendRallarCrdtLiveUpdate({
            update,
            transport: this.readTransport?.(),
            strategy: this.transport,
            policies: this.policies
        });
        this.rememberLiveSendOutcome(outcome);
        if (outcome.status === 'failed') {
            this.lastSyncError = outcome.reason ?? 'CRDT live update send failed.';
        }
    }

    private async requestLiveCatchUp(
        reason: string,
        strategy: RallarCrdtTransportStrategy = this.transport
    ): Promise<void> {
        if (strategy === 'local-only') {
            return;
        }

        const request: RallarCrdtSyncRequestEnvelope = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            requestId: createRandomId('sync-request'),
            replicaId: this.engine.replicaId,
            createdAtEpochMs: this.now(),
            knownUpdateIds: Array.from(this.engine.seenUpdateIds()).sort(),
            missingUpdateIds: this.engine.dependencyState().missingUpdateIds,
            maxUpdateCount: 100
        };
        const outcome = await sendRallarCrdtSyncRequest({
            request,
            transport: this.readTransport?.(),
            strategy,
            policies: this.policies
        });
        this.rememberLiveSendOutcome(outcome);
        if (outcome.status === 'sent') {
            this.liveSyncRequestCount += 1;
        }
        else if (outcome.status === 'failed') {
            this.lastSyncError = outcome.reason ??
                `CRDT live catch-up request failed: ${reason}.`;
        }
    }

    private async requestDurableCatchUp(
        reason: string,
        strategy: RallarCrdtTransportStrategy = this.transport
    ): Promise<boolean> {
        if (!strategyUsesWs(strategy)) {
            return false;
        }

        const request: RallarCrdtCatchUpRequestEnvelope = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            requestId: createRandomId('catch-up-request'),
            replicaId: this.engine.replicaId,
            createdAtEpochMs: this.now(),
            afterSequence: this.lastServerAppendSequence,
            maxUpdateCount: 100,
            includeSnapshot: this.lastServerAppendSequence === undefined
        };
        const outcome = await sendRallarCrdtCatchUpRequest({
            request,
            transport: this.readTransport?.(),
            policies: this.policies
        });
        this.rememberLiveSendOutcome(outcome);
        if (outcome.status === 'failed') {
            this.lastSyncError = outcome.reason ??
                `CRDT durable catch-up request failed: ${reason}.`;
        }
        return outcome.status === 'sent';
    }

    private async requestHttpCatchUp(reason: string): Promise<boolean> {
        if (!this.durableCatchUp || this.transport === 'local-only') {
            return false;
        }

        const request: RallarCrdtCatchUpRequestEnvelope = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            requestId: createRandomId('http-catch-up-request'),
            replicaId: this.engine.replicaId,
            createdAtEpochMs: this.now(),
            afterSequence: this.lastServerAppendSequence,
            maxUpdateCount: 100,
            includeSnapshot: this.lastServerAppendSequence === undefined
        };

        try {
            await this.handleCatchUpResponse(
                await this.durableCatchUp(request),
                undefined
            );
            this.lastSyncError = undefined;
            return true;
        }
        catch (error) {
            this.lastSyncError = `CRDT HTTP catch-up failed: ${reason}: ${toErrorMessage(error)}`;
            return false;
        }
    }

    private async handleSyncRequest(
        request: RallarCrdtSyncRequestEnvelope,
        transport: RallarCrdtTransportKind
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(request.document) !== this.documentKey) {
            return;
        }
        if (request.replicaId === this.engine.replicaId) {
            return;
        }

        const known = new Set(request.knownUpdateIds);
        const missingFilter = request.missingUpdateIds?.length
            ? new Set(request.missingUpdateIds)
            : undefined;
        const updates = this.pendingUpdates()
            .filter((update) => !known.has(update.updateId))
            .filter((update) => missingFilter ? missingFilter.has(update.updateId) : true)
            .slice(0, request.maxUpdateCount ?? 100);
        const response: RallarCrdtSyncResponseEnvelope<unknown, TPayload> = {
            protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
            document: this.ref,
            requestId: request.requestId,
            responseId: createRandomId('sync-response'),
            replicaId: this.engine.replicaId,
            createdAtEpochMs: this.now(),
            updates,
            hasMore: updates.length >= (request.maxUpdateCount ?? 100),
            reason: 'peer-catch-up-development-only'
        };
        const outcome = await sendRallarCrdtSyncResponse({
            response,
            transport: this.readTransport?.(),
            replyTransport: transport,
            policies: this.policies
        });
        this.rememberLiveSendOutcome(outcome);
        if (outcome.status === 'sent') {
            this.liveSyncResponseCount += 1;
        }
    }

    private async handleSyncResponse(
        response: RallarCrdtSyncResponseEnvelope<unknown, TPayload>,
        transport: RallarCrdtTransportKind
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(response.document) !== this.documentKey) {
            return;
        }
        if (response.replicaId === this.engine.replicaId) {
            return;
        }

        this.liveSyncResponseCount += 1;
        if (response.snapshot) {
            this.engine.importSnapshot(
                await this.revealSnapshotForMerge(
                    response.snapshot as RallarCrdtSnapshotEnvelope<TValue>
                )
            );
        }
        for (const update of response.updates) {
            await this.applyRemoteUpdate(update, transport);
        }
    }

    private async handleCatchUpResponse(
        response: RallarCrdtCatchUpResponseEnvelope<unknown, TPayload>,
        transport: RallarCrdtTransportKind | undefined
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(response.document) !== this.documentKey) {
            return;
        }

        if (response.snapshot) {
            this.engine.importSnapshot(
                await this.revealSnapshotForMerge(
                    response.snapshot as RallarCrdtSnapshotEnvelope<TValue>
                )
            );
            this.lastSnapshotAtEpochMs = response.snapshot.createdAtEpochMs;
        }
        for (const record of response.page.records) {
            await this.applyRemoteUpdate(record.update, transport);
            this.lastServerAppendSequence = Math.max(
                this.lastServerAppendSequence ?? 0,
                record.append.appendSequence
            );
        }
        if (response.page.lastSequence !== undefined) {
            this.lastServerAppendSequence = Math.max(
                this.lastServerAppendSequence ?? 0,
                response.page.lastSequence
            );
        }
    }

    private async handleAppendResponse(
        response: RallarCrdtAppendResponseEnvelope<TPayload>
    ): Promise<void> {
        if (toRallarCrdtDocumentKey(response.document) !== this.documentKey) {
            return;
        }

        this.lastServerAckAtEpochMs = response.acceptedAtEpochMs;
        for (const result of response.results) {
            if (result.status === 'accepted' || result.status === 'duplicate') {
                this.lastServerAppendSequence = Math.max(
                    this.lastServerAppendSequence ?? 0,
                    result.append.appendSequence
                );
                this.pending.delete(result.update.updateId);
                await this.localStore?.removePendingUpdate(
                    this.ref,
                    result.update.updateId
                );
                continue;
            }

            if (!result.update) {
                continue;
            }

            this.pending.delete(result.update.updateId);
            await this.localStore?.removePendingUpdate(
                this.ref,
                result.update.updateId
            );
            const failed: RallarCrdtFailedPendingUpdate<TPayload> = {
                update: result.update,
                failedAtEpochMs: this.now(),
                retryable: result.retryable,
                reason: result.reason
            };
            this.failed.set(result.update.updateId, failed);
            await this.localStore?.writeFailedPendingUpdate(failed);
        }
    }

    private rememberLiveSendOutcome(
        outcome: Awaited<ReturnType<typeof sendRallarCrdtLiveUpdate<TPayload>>>
    ): void {
        this.liveSentUpdateCount += outcome.sentCount;
        const lastResult = outcome.results[outcome.results.length - 1];
        if (lastResult) {
            this.lastLiveTransport = lastResult.transport;
            this.lastLiveSendStatus = lastResult.status;
        }
    }

    private recordMetric(
        name: Parameters<RallarCrdtMetricsSink['record']>[0]['name'],
        value: number,
        tags?: Readonly<Record<string, string>>
    ): void {
        void this.metrics?.record({
            name,
            value,
            atEpochMs: this.now(),
            documentKey: this.documentKey,
            tags
        });
    }

    private recordSyncMetrics(result: RallarCrdtSyncResult): void {
        this.recordMetric('crdt.sync.bytes', byteLengthOfJson(result), {
            status: result.status
        });
        this.recordMetric(
            'crdt.dependency.blocked.count',
            result.dependencyBlockedUpdateCount
        );
    }

    private rememberLiveApplyResult(
        result: RallarCrdtApplyResult,
        transport: RallarCrdtTransportKind | undefined
    ): void {
        if (transport) {
            this.lastLiveTransport = transport;
        }
        if (result.status === 'applied') {
            this.liveReceivedUpdateCount += 1;
        }
        else if (result.status === 'duplicate') {
            this.liveDuplicateUpdateCount += 1;
        }
        else if (result.status === 'dependency-blocked') {
            this.liveDependencyBlockedUpdateCount += 1;
        }
        else if (result.status === 'rejected') {
            this.liveRejectedUpdateCount += 1;
        }
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

function toDocumentRef(
    name: string,
    options: RallarCrdtOpenOptions,
    defaults: RallarCrdtFacadeDefaults | undefined
): RallarCrdtDocumentRef {
    const scope = options.scope ?? toDefaultScope(defaults);
    const applicationId = options.applicationId ??
        (scope.kind === 'room' ? scope.roomRef.applicationId : undefined) ??
        defaults?.applicationId;
    const workspaceId = options.workspaceId ??
        (scope.kind === 'room' ? scope.roomRef.workspaceId : undefined) ??
        defaults?.workspaceId;

    if (!applicationId) {
        throw new Error(
            'Cannot open CRDT document: applicationId is required.'
        );
    }

    const documentType = options.documentType ?? name;
    const documentId = options.documentId ??
        (scope.kind === 'room' ? scope.roomRef.groupId : name);

    switch (scope.kind) {
        case 'app':
            return {
                applicationId,
                workspaceId,
                scope: 'app',
                documentType,
                documentId
            };
        case 'principal':
            return {
                applicationId,
                workspaceId,
                scope: 'principal',
                documentType,
                documentId,
                principalId: scope.principalId
            };
        case 'room':
            return {
                applicationId,
                workspaceId,
                scope: 'room',
                documentType,
                documentId,
                roomRef: scope.roomRef
            };
        case 'custom':
            return {
                applicationId,
                workspaceId,
                scope: 'custom',
                documentType,
                documentId,
                customScope: scope.customScope
            };
    }
}

function toDefaultScope(
    defaults: RallarCrdtFacadeDefaults | undefined
): RallarCrdtOpenScope {
    if (defaults?.room?.roomRef) {
        return {
            kind: 'room',
            roomRef: defaults.room.roomRef
        };
    }

    return { kind: 'app' };
}

function sortUpdates<TPayload extends RallarCrdtOperationBatch>(
    updates: readonly RallarCrdtUpdateEnvelope<TPayload>[]
): RallarCrdtUpdateEnvelope<TPayload>[] {
    return [...updates].sort(
        (left, right) =>
            left.lamport - right.lamport ||
            left.createdAtEpochMs - right.createdAtEpochMs ||
            left.replicaId.localeCompare(right.replicaId) ||
            left.updateId.localeCompare(right.updateId)
    );
}

function notifyListener<TValue>(
    listener: RallarCrdtSnapshotListener<TValue>,
    snapshot: RallarCrdtSnapshotEnvelope<TValue>
): void {
    void Promise.resolve(listener(snapshot)).catch((error) => {
        console.error('Error notifying CRDT snapshot listener', error);
    });
}

function createRandomId(prefix: string): string {
    const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    return randomUUID
        ? randomUUID()
        : `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function byteLengthOfJson(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function strategyUsesWs(strategy: RallarCrdtTransportStrategy): boolean {
    return (
        strategy === 'ws' ||
        strategy === 'ws-then-rtc' ||
        strategy === 'rtc-with-ws-fallback'
    );
}
