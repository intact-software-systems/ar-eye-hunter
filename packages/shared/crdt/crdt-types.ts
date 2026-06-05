import type {
    ActorId,
    ApplicationId,
    GroupRef,
    PrincipalId,
    SessionId,
    WorkspaceId,
} from '../api/group-types.ts';

export const RALLAR_CRDT_PROTOCOL_VERSION = 1;
export const RALLAR_CRDT_OPERATION_VERSION = 1;

export type RallarCrdtProtocolVersion = typeof RALLAR_CRDT_PROTOCOL_VERSION;

export const RALLAR_CRDT_ROOM_TOPIC_ID = 'room.crdt';
export const RALLAR_CRDT_APP_TOPIC_ID = 'app.crdt';

export const RALLAR_CRDT_UPDATE_TYPE_ID = 'rallar.crdt.update.v1';
export const RALLAR_CRDT_SYNC_REQUEST_TYPE_ID = 'rallar.crdt.sync-request.v1';
export const RALLAR_CRDT_SYNC_RESPONSE_TYPE_ID = 'rallar.crdt.sync-response.v1';
export const RALLAR_CRDT_SNAPSHOT_TYPE_ID = 'rallar.crdt.snapshot.v1';

export type RallarCrdtJsonPrimitive = string | number | boolean | null;

export type RallarCrdtJsonValue =
    | RallarCrdtJsonPrimitive
    | readonly RallarCrdtJsonValue[]
    | { readonly [key: string]: RallarCrdtJsonValue };

export type RallarCrdtDocumentScope = 'app' | 'principal' | 'room' | 'custom';

export type RallarCrdtDocumentRef = Readonly<{
    applicationId: ApplicationId;
    workspaceId?: WorkspaceId;
    scope: RallarCrdtDocumentScope;
    documentType: string;
    documentId: string;
    roomRef?: GroupRef;
    principalId?: PrincipalId;
    customScope?: string;
}>;

export type RallarCrdtPath = readonly string[];

export type RallarCrdtOrSetAddOperation = Readonly<{
    kind: 'orset.add';
    path: RallarCrdtPath;
    elementId: string;
    value: RallarCrdtJsonValue;
}>;

export type RallarCrdtOrSetRemoveOperation = Readonly<{
    kind: 'orset.remove';
    path: RallarCrdtPath;
    elementId: string;
    observedAddUpdateIds: readonly string[];
}>;

export type RallarCrdtRegisterPolicy = 'lww' | 'multi';

export type RallarCrdtRegisterSetOperation = Readonly<{
    kind: 'register.set';
    path: RallarCrdtPath;
    value: RallarCrdtJsonValue;
    policy: RallarCrdtRegisterPolicy;
}>;

export type RallarCrdtMapSetOperation = Readonly<{
    kind: 'map.set';
    path: RallarCrdtPath;
    key: string;
    value: RallarCrdtJsonValue;
}>;

export type RallarCrdtMapDeleteOperation = Readonly<{
    kind: 'map.delete';
    path: RallarCrdtPath;
    key: string;
    observedUpdateIds: readonly string[];
}>;

export type RallarCrdtSequenceInsertOperation = Readonly<{
    kind: 'sequence.insert';
    path: RallarCrdtPath;
    elementId: string;
    positionId: string;
    value: RallarCrdtJsonValue;
}>;

export type RallarCrdtSequenceDeleteOperation = Readonly<{
    kind: 'sequence.delete';
    path: RallarCrdtPath;
    elementId: string;
    observedUpdateIds: readonly string[];
}>;

export type RallarCrdtSequenceMoveOperation = Readonly<{
    kind: 'sequence.move';
    path: RallarCrdtPath;
    elementId: string;
    positionId: string;
    observedUpdateIds: readonly string[];
}>;

export type RallarCrdtCounterAddOperation = Readonly<{
    kind: 'counter.add';
    path: RallarCrdtPath;
    delta: number;
}>;

export type RallarCrdtNumberMergePolicy = 'min' | 'max';

export type RallarCrdtNumberMinOperation = Readonly<{
    kind: 'number.min';
    path: RallarCrdtPath;
    value: number;
}>;

export type RallarCrdtNumberMaxOperation = Readonly<{
    kind: 'number.max';
    path: RallarCrdtPath;
    value: number;
}>;

export type RallarCrdtOperation =
    | RallarCrdtOrSetAddOperation
    | RallarCrdtOrSetRemoveOperation
    | RallarCrdtRegisterSetOperation
    | RallarCrdtMapSetOperation
    | RallarCrdtMapDeleteOperation
    | RallarCrdtSequenceInsertOperation
    | RallarCrdtSequenceDeleteOperation
    | RallarCrdtSequenceMoveOperation
    | RallarCrdtCounterAddOperation
    | RallarCrdtNumberMinOperation
    | RallarCrdtNumberMaxOperation;

export type RallarCrdtOperationKind = RallarCrdtOperation['kind'];

export type RallarCrdtPathKind =
    | 'register'
    | 'map'
    | 'orset'
    | 'sequence'
    | 'counter'
    | 'number';

export type RallarCrdtPathSchemaEntry = Readonly<{
    path: RallarCrdtPath;
    kind: RallarCrdtPathKind;
}>;

export type RallarCrdtPathSchema = Readonly<{
    mode: 'permissive' | 'strict';
    paths: readonly RallarCrdtPathSchemaEntry[];
}>;

export type RallarCrdtEncryptionAlgorithm = 'AES-GCM-256';

export type RallarCrdtEncryptedPlaintextType =
    | 'operation-batch'
    | 'snapshot-body';

export type RallarCrdtEncryptedJsonEnvelope = Readonly<{
    kind: 'encrypted-json';
    format: 'rallar.crdt.encrypted-json.v1';
    algorithm: RallarCrdtEncryptionAlgorithm;
    keyId: string;
    nonce: string;
    ciphertext: string;
    plaintextHash: string;
    aadHash: string;
    plaintextType: RallarCrdtEncryptedPlaintextType;
    encryptedAtEpochMs: number;
    visibleMetadataFields?: readonly string[];
}>;

export type RallarCrdtOperationBatch = Readonly<{
    kind: 'batch';
    operations: readonly RallarCrdtOperation[];
    operationGroupId?: string;
    undo?: RallarCrdtUndoRedoMetadata;
    redo?: RallarCrdtUndoRedoMetadata;
    encryption?: RallarCrdtEncryptedJsonEnvelope;
}>;

export type RallarCrdtUndoRedoMetadata = Readonly<{
    actorId: ActorId;
    targetOperationGroupId: string;
    targetUpdateIds: readonly string[];
}>;

export type RallarCrdtClockSummary = Readonly<{
    maxLamport: number;
    replicaClocks: Readonly<Record<string, number>>;
}>;

export type RallarCrdtCausalFrontier = Readonly<{
    frontierUpdateIds: readonly string[];
    replicaClocks?: Readonly<Record<string, number>>;
}>;

export type RallarCrdtUpdateEnvelope<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        protocolVersion: 1;
        document: RallarCrdtDocumentRef;
        updateId: string;
        replicaId: string;
        actorId?: ActorId;
        sessionId?: SessionId;
        lamport: number;
        parents: readonly string[];
        schemaVersion: number;
        operationVersion: number;
        createdAtEpochMs: number;
        causalFrontier?: RallarCrdtCausalFrontier;
        payload: TPayload;
        hash?: string;
    }>;

export type RallarCrdtCrdtStateWrite = Readonly<{
    updateId: string;
    replicaId: string;
    lamport: number;
    createdAtEpochMs: number;
    parents: readonly string[];
}>;

export type RallarCrdtRegisterSnapshotWrite = RallarCrdtCrdtStateWrite &
    Readonly<{
        policy: RallarCrdtRegisterPolicy;
        value: RallarCrdtJsonValue;
    }>;

export type RallarCrdtSetSnapshotAdd = RallarCrdtCrdtStateWrite &
    Readonly<{
        elementId: string;
        value: RallarCrdtJsonValue;
    }>;

export type RallarCrdtMapSnapshotSet = RallarCrdtCrdtStateWrite &
    Readonly<{
        key: string;
        value: RallarCrdtJsonValue;
    }>;

export type RallarCrdtCounterSnapshotAdd = RallarCrdtCrdtStateWrite &
    Readonly<{
        delta: number;
    }>;

export type RallarCrdtNumberSnapshotWrite = RallarCrdtCrdtStateWrite &
    Readonly<{
        merge: RallarCrdtNumberMergePolicy;
        value: number;
    }>;

export type RallarCrdtCrdtStateSnapshot = Readonly<{
    format: 'rallar.crdt.state.v1';
    registers: Readonly<
        Record<
            string,
            Readonly<{
                path: RallarCrdtPath;
                writes: readonly RallarCrdtRegisterSnapshotWrite[];
            }>
        >
    >;
    sets: Readonly<
        Record<
            string,
            Readonly<{
                path: RallarCrdtPath;
                elements: readonly Readonly<{
                    elementId: string;
                    adds: readonly RallarCrdtSetSnapshotAdd[];
                    removes: readonly string[];
                }>[];
            }>
        >
    >;
    maps: Readonly<
        Record<
            string,
            Readonly<{
                path: RallarCrdtPath;
                entries: readonly Readonly<{
                    key: string;
                    sets: readonly RallarCrdtMapSnapshotSet[];
                    deletes: readonly string[];
                }>[];
            }>
        >
    >;
    sequences: RallarCrdtSequenceSnapshotState;
    counters?: Readonly<
        Record<
            string,
            Readonly<{
                path: RallarCrdtPath;
                adds: readonly RallarCrdtCounterSnapshotAdd[];
            }>
        >
    >;
    numbers?: Readonly<
        Record<
            string,
            Readonly<{
                path: RallarCrdtPath;
                writes: readonly RallarCrdtNumberSnapshotWrite[];
            }>
        >
    >;
}>;

export type RallarCrdtSnapshotMetadata = Readonly<{
    createdByReplicaId?: string;
    updateCount: number;
    tombstoneCount?: number;
    conflictCount?: number;
    reason?: string;
    crdtState?: RallarCrdtCrdtStateSnapshot;
    sequenceState?: RallarCrdtSequenceSnapshotState;
    unsafeLegacyCollectionCompaction?: boolean;
}>;

export type RallarCrdtSequenceSnapshotState = Readonly<
    Record<string, RallarCrdtSequenceSnapshotPathState>
>;

export type RallarCrdtSequenceSnapshotPathState = Readonly<{
    path: RallarCrdtPath;
    entries: readonly RallarCrdtSequenceSnapshotEntry[];
}>;

export type RallarCrdtSequenceSnapshotEntry = Readonly<{
    elementId: string;
    positionId: string;
    value: RallarCrdtJsonValue;
    insertUpdateId: string;
    positionUpdateId: string;
    replicaId: string;
    lamport: number;
    createdAtEpochMs: number;
}>;

export type RallarCrdtSnapshotEnvelope<TValue = unknown> = Readonly<{
    protocolVersion: 1;
    document: RallarCrdtDocumentRef;
    snapshotId: string;
    schemaVersion: number;
    createdAtEpochMs: number;
    maxLamport: number;
    includedUpdateIds: readonly string[];
    updateClock?: RallarCrdtClockSummary;
    value: TValue;
    metadata: RallarCrdtSnapshotMetadata;
    hash?: string;
}>;

export type RallarCrdtSyncRequestEnvelope = Readonly<{
    protocolVersion: 1;
    document: RallarCrdtDocumentRef;
    requestId: string;
    replicaId: string;
    createdAtEpochMs: number;
    knownUpdateIds: readonly string[];
    missingUpdateIds?: readonly string[];
    updateClock?: RallarCrdtClockSummary;
    maxUpdateCount?: number;
}>;

export type RallarCrdtSyncResponseEnvelope<
    TValue = unknown,
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    protocolVersion: 1;
    document: RallarCrdtDocumentRef;
    requestId: string;
    responseId: string;
    replicaId: string;
    createdAtEpochMs: number;
    snapshot?: RallarCrdtSnapshotEnvelope<TValue>;
    updates: readonly RallarCrdtUpdateEnvelope<TPayload>[];
    hasMore?: boolean;
    reason?: string;
}>;

export type RallarCrdtValidationIssue = Readonly<{
    path: string;
    code: string;
    message: string;
}>;

export type RallarCrdtValidationResult = Readonly<{
    valid: boolean;
    issues: readonly RallarCrdtValidationIssue[];
}>;

export type RallarCrdtApplyStatus =
    | 'applied'
    | 'duplicate'
    | 'dependency-blocked'
    | 'rejected';

export type RallarCrdtApplyResult = Readonly<{
    status: RallarCrdtApplyStatus;
    updateId: string;
    appliedUpdateIds: readonly string[];
    releasedUpdateIds: readonly string[];
    missingDependencyIds: readonly string[];
    validation?: RallarCrdtValidationResult;
    error?: string;
}>;

export type RallarCrdtDependencyState = Readonly<{
    seenUpdateIds: readonly string[];
    blockedUpdateIds: readonly string[];
    missingUpdateIds: readonly string[];
    dependencyBlockedCount: number;
}>;

export type RallarCrdtConflictValue = Readonly<{
    updateId: string;
    replicaId: string;
    lamport: number;
    createdAtEpochMs: number;
    value: RallarCrdtJsonValue;
}>;

export type RallarCrdtConflict = Readonly<{
    kind: 'multi-value-register';
    path: RallarCrdtPath;
    values: readonly RallarCrdtConflictValue[];
}>;

export type RallarCrdtFailedPendingUpdate<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        failedAtEpochMs: number;
        retryable: boolean;
        reason: string;
    }>;

export type RallarCrdtDependencyBlockedUpdate<
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    update: RallarCrdtUpdateEnvelope<TPayload>;
    blockedAtEpochMs: number;
    missingDependencyIds: readonly string[];
    reason?: string;
}>;

export type RallarCrdtQuotaState = Readonly<{
    usageBytes?: number;
    quotaBytes?: number;
    nearingLimit?: boolean;
}>;

export type RallarCrdtDocumentHealth = Readonly<{
    replicaId: string;
    pendingUpdateCount: number;
    failedPendingUpdateCount: number;
    dependencyBlockedUpdateCount: number;
    seenUpdateCount: number;
    lastServerAppendSequence?: number;
    lastServerAckAtEpochMs?: number;
    lastSyncError?: string;
    snapshotAgeMs?: number;
    updateLogLag?: number;
    quota?: RallarCrdtQuotaState;
    replayDurationMs?: number;
    corruptLocalArtifactCount?: number;
    transportStrategy?: RallarCrdtTransportStrategy;
    lastLiveTransport?: 'ws' | 'rtc';
    lastLiveSendStatus?: string;
    liveSentUpdateCount?: number;
    liveReceivedUpdateCount?: number;
    liveDuplicateUpdateCount?: number;
    liveRejectedUpdateCount?: number;
    liveDependencyBlockedUpdateCount?: number;
    liveRetriedUpdateCount?: number;
    liveSyncRequestCount?: number;
    liveSyncResponseCount?: number;
}>;

export type RallarCrdtTransportStrategy =
    | 'local-only'
    | 'ws'
    | 'rtc'
    | 'ws-then-rtc'
    | 'rtc-with-ws-fallback';

export type RallarCrdtSyncStatus =
    | 'local-only'
    | 'synced'
    | 'deferred'
    | 'failed';

export type RallarCrdtSyncOptions = Readonly<{
    reason?: string;
    transport?: RallarCrdtTransportStrategy;
}>;

export type RallarCrdtSyncResult = Readonly<{
    status: RallarCrdtSyncStatus;
    transport: RallarCrdtTransportStrategy;
    sentUpdateCount: number;
    receivedUpdateCount: number;
    pendingUpdateCount: number;
    dependencyBlockedUpdateCount: number;
    reason?: string;
    error?: string;
}>;
