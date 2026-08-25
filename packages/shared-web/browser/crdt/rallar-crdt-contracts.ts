import type { RallarCrdtMessageTransport } from '@shared-web/browser/crdt/browser-crdt-transport.ts';
import type { RallarDataFacade, RallarUnsubscribe } from '@shared-web/browser/rallar-data.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type {
    RallarCrdtCatchUpRequestEnvelope,
    RallarCrdtCatchUpResponseEnvelope,
    RallarCrdtDependencyBlockedUpdate,
    RallarCrdtDocumentHealth,
    RallarCrdtDocumentRef,
    RallarCrdtDocumentTypePolicy,
    RallarCrdtEncryptionKeyring,
    RallarCrdtFailedPendingUpdate,
    RallarCrdtJsonValue,
    RallarCrdtMetricsSink,
    RallarCrdtOperation,
    RallarCrdtOperationBatch,
    RallarCrdtPath,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtSyncOptions,
    RallarCrdtSyncResult,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope,
    RallarCrdtValidationOptions
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
    TValue = RallarCrdtJsonValue,
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
) => Promise<RallarCrdtCatchUpResponseEnvelope>;

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
    open<TValue = RallarCrdtJsonValue, TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch>(
        name: string,
        options?: RallarCrdtOpenOptions<TValue, TPayload>
    ): Promise<RallarCrdtDocument<TValue, TPayload>>;
}>;
