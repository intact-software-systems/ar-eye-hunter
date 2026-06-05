import type { ActorId, PrincipalId, SessionId } from '../api/group-types.ts';
import type {
    RallarCrdtDocumentRef,
    RallarCrdtOperationBatch,
    RallarCrdtProtocolVersion,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtUpdateEnvelope,
    RallarCrdtValidationResult,
} from './crdt-types.ts';
import { RALLAR_CRDT_PROTOCOL_VERSION } from './crdt-types.ts';

export const RALLAR_CRDT_APPEND_REQUEST_TYPE_ID =
    'rallar.crdt.append-request.v1';
export const RALLAR_CRDT_APPEND_RESPONSE_TYPE_ID =
    'rallar.crdt.append-response.v1';
export const RALLAR_CRDT_CATCH_UP_REQUEST_TYPE_ID =
    'rallar.crdt.catch-up-request.v1';
export const RALLAR_CRDT_CATCH_UP_RESPONSE_TYPE_ID =
    'rallar.crdt.catch-up-response.v1';

export type RallarCrdtAppendSequence = number;

export type RallarCrdtDocumentLifecycleState =
    | 'active'
    | 'archived'
    | 'destroyed'
    | 'quarantined';

export type RallarCrdtAuthorizationScope =
    | 'room'
    | 'principal'
    | 'app'
    | 'custom';

export type RallarCrdtRetentionPolicy = Readonly<{
    mode: 'retain' | 'redact-after' | 'delete-after';
    ttlMs?: number;
    sensitivePayloads?: boolean;
    reason?: string;
}>;

export type RallarCrdtQuotaPolicy = Readonly<{
    maxUpdateBytes?: number;
    maxDocumentBytes?: number;
    maxUpdateCount?: number;
    maxPendingUpdatesPerReplica?: number;
    maxUpdatesPerMinutePerActor?: number;
}>;

export type RallarCrdtTrustedAppendInput = Readonly<{
    actorId?: ActorId;
    principalId?: PrincipalId;
    sessionId?: SessionId;
    serverId?: string;
    authorizationScope: RallarCrdtAuthorizationScope;
    acceptedAtEpochMs?: number;
}>;

export type RallarCrdtTrustedAppendMetadata = Readonly<{
    appendSequence: RallarCrdtAppendSequence;
    acceptedAtEpochMs: number;
    actorId?: ActorId;
    principalId?: PrincipalId;
    sessionId?: SessionId;
    serverId?: string;
    authorizationScope: RallarCrdtAuthorizationScope;
    acceptedUpdateHash: string;
}>;

export type RallarCrdtDocumentMetadata = Readonly<{
    document: RallarCrdtDocumentRef;
    documentKey: string;
    lifecycle: RallarCrdtDocumentLifecycleState;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    archivedAtEpochMs?: number;
    destroyedAtEpochMs?: number;
    lastAppendSequence: RallarCrdtAppendSequence;
    updateCount: number;
    snapshotCount: number;
    retention?: RallarCrdtRetentionPolicy;
    quota?: RallarCrdtQuotaPolicy;
    projectionIds?: readonly string[];
}>;

export type RallarCrdtDurableUpdateRecord<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        document: RallarCrdtDocumentRef;
        documentKey: string;
        update: RallarCrdtUpdateEnvelope<TPayload>;
        append: RallarCrdtTrustedAppendMetadata;
    }>;

export type RallarCrdtAppendRejectionCode =
    | 'authorization-denied'
    | 'document-archived'
    | 'document-destroyed'
    | 'document-quarantined'
    | 'duplicate-hash-mismatch'
    | 'feature-disabled'
    | 'invalid-update'
    | 'quota-exceeded'
    | 'rate-limited'
    | 'schema-version-not-allowed'
    | 'update-too-large'
    | 'storage-failed';

export type RallarCrdtAppendUpdateInput<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        update: RallarCrdtUpdateEnvelope<TPayload>;
        trusted: RallarCrdtTrustedAppendInput;
        idempotencyKey?: string;
    }>;

export type RallarCrdtAppendAccepted<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        status: 'accepted';
        update: RallarCrdtUpdateEnvelope<TPayload>;
        append: RallarCrdtTrustedAppendMetadata;
        document: RallarCrdtDocumentMetadata;
    }>;

export type RallarCrdtAppendDuplicate<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        status: 'duplicate';
        update: RallarCrdtUpdateEnvelope<TPayload>;
        append: RallarCrdtTrustedAppendMetadata;
        document: RallarCrdtDocumentMetadata;
    }>;

export type RallarCrdtAppendRejected<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        status: 'rejected';
        update?: RallarCrdtUpdateEnvelope<TPayload>;
        code: RallarCrdtAppendRejectionCode;
        reason: string;
        retryable: boolean;
        validation?: RallarCrdtValidationResult;
        document?: RallarCrdtDocumentMetadata;
    }>;

export type RallarCrdtAppendResult<TPayload = RallarCrdtOperationBatch> =
    | RallarCrdtAppendAccepted<TPayload>
    | RallarCrdtAppendDuplicate<TPayload>
    | RallarCrdtAppendRejected<TPayload>;

export type RallarCrdtAppendBatchInput<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        document: RallarCrdtDocumentRef;
        updates: readonly RallarCrdtAppendUpdateInput<TPayload>[];
        stopOnFirstRejection?: boolean;
    }>;

export type RallarCrdtAppendBatchResult<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        status: 'accepted' | 'partial' | 'rejected';
        document: RallarCrdtDocumentRef;
        results: readonly RallarCrdtAppendResult<TPayload>[];
    }>;

export type RallarCrdtListUpdatesInput = Readonly<{
    document: RallarCrdtDocumentRef;
    afterSequence?: RallarCrdtAppendSequence;
    afterCursor?: string;
    limit?: number;
    includeRejected?: boolean;
}>;

export type RallarCrdtUpdatePage<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        document: RallarCrdtDocumentRef;
        records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
        firstSequence?: RallarCrdtAppendSequence;
        lastSequence?: RallarCrdtAppendSequence;
        nextCursor?: string;
        hasMore: boolean;
    }>;

export type RallarCrdtWriteSnapshotInput<TValue = unknown> = Readonly<{
    snapshot: RallarCrdtSnapshotEnvelope<TValue>;
    appendSequence: RallarCrdtAppendSequence;
    reason?: string;
}>;

export type RallarCrdtLifecycleInput = Readonly<{
    document: RallarCrdtDocumentRef;
    lifecycle: RallarCrdtDocumentLifecycleState;
    changedAtEpochMs?: number;
    retention?: RallarCrdtRetentionPolicy;
    quota?: RallarCrdtQuotaPolicy;
    projectionIds?: readonly string[];
}>;

export type RallarCrdtAppendRequestEnvelope<
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    protocolVersion: RallarCrdtProtocolVersion;
    requestId: string;
    document: RallarCrdtDocumentRef;
    replicaId: string;
    createdAtEpochMs: number;
    updates: readonly RallarCrdtUpdateEnvelope<TPayload>[];
}>;

export type RallarCrdtAppendResponseEnvelope<
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    protocolVersion: RallarCrdtProtocolVersion;
    requestId: string;
    document: RallarCrdtDocumentRef;
    acceptedAtEpochMs: number;
    results: readonly RallarCrdtAppendResult<TPayload>[];
}>;

export type RallarCrdtCatchUpRequestEnvelope = Readonly<{
    protocolVersion: RallarCrdtProtocolVersion;
    requestId: string;
    document: RallarCrdtDocumentRef;
    replicaId: string;
    createdAtEpochMs: number;
    afterSequence?: RallarCrdtAppendSequence;
    afterCursor?: string;
    maxUpdateCount?: number;
    includeSnapshot?: boolean;
}>;

export type RallarCrdtCatchUpResponseEnvelope<
    TValue = unknown,
    TPayload = RallarCrdtOperationBatch,
> = Readonly<{
    protocolVersion: RallarCrdtProtocolVersion;
    requestId: string;
    document: RallarCrdtDocumentRef;
    createdAtEpochMs: number;
    snapshot?: RallarCrdtSnapshotEnvelope<TValue>;
    page: RallarCrdtUpdatePage<TPayload>;
}>;

export type RallarCrdtProjectionHooks<TPayload = RallarCrdtOperationBatch> =
    Readonly<{
        onAppendAccepted?: (
            record: RallarCrdtDurableUpdateRecord<TPayload>,
        ) => void | Promise<void>;
        onLifecycleChanged?: (
            metadata: RallarCrdtDocumentMetadata,
        ) => void | Promise<void>;
        rebuild?: (document: RallarCrdtDocumentRef) => void | Promise<void>;
    }>;

export type RallarCrdtUpdateLogRepository<
    TPayload = RallarCrdtOperationBatch,
    TValue = unknown,
> = Readonly<{
    append(
        input: RallarCrdtAppendUpdateInput<TPayload>,
    ): Promise<RallarCrdtAppendResult<TPayload>>;
    appendBatch(
        input: RallarCrdtAppendBatchInput<TPayload>,
    ): Promise<RallarCrdtAppendBatchResult<TPayload>>;
    listAfter(
        input: RallarCrdtListUpdatesInput,
    ): Promise<RallarCrdtUpdatePage<TPayload>>;
    readSnapshot(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined>;
    writeSnapshot(input: RallarCrdtWriteSnapshotInput<TValue>): Promise<void>;
    readDocumentMetadata(
        document: RallarCrdtDocumentRef,
    ): Promise<RallarCrdtDocumentMetadata | undefined>;
    updateDocumentLifecycle(
        input: RallarCrdtLifecycleInput,
    ): Promise<RallarCrdtDocumentMetadata>;
}>;

export function isRallarCrdtAppendAccepted<TPayload>(
    result: RallarCrdtAppendResult<TPayload>,
): result is RallarCrdtAppendAccepted<TPayload> {
    return result.status === 'accepted';
}

export function isRallarCrdtAppendDuplicate<TPayload>(
    result: RallarCrdtAppendResult<TPayload>,
): result is RallarCrdtAppendDuplicate<TPayload> {
    return result.status === 'duplicate';
}

export function isRallarCrdtAppendRejected<TPayload>(
    result: RallarCrdtAppendResult<TPayload>,
): result is RallarCrdtAppendRejected<TPayload> {
    return result.status === 'rejected';
}

export function toRallarCrdtAppendCursor(
    sequence: RallarCrdtAppendSequence,
): string {
    return `seq:${sequence}`;
}

export function fromRallarCrdtAppendCursor(
    cursor: string | undefined,
): RallarCrdtAppendSequence | undefined {
    if (!cursor) {
        return undefined;
    }

    if (!cursor.startsWith('seq:')) {
        return undefined;
    }

    const value = Number(cursor.slice(4));
    return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function createRallarCrdtAppendRequestEnvelope<TPayload>(
    input: Omit<RallarCrdtAppendRequestEnvelope<TPayload>, 'protocolVersion'>,
): RallarCrdtAppendRequestEnvelope<TPayload> {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        ...input,
    };
}

export function createRallarCrdtCatchUpRequestEnvelope(
    input: Omit<RallarCrdtCatchUpRequestEnvelope, 'protocolVersion'>,
): RallarCrdtCatchUpRequestEnvelope {
    return {
        protocolVersion: RALLAR_CRDT_PROTOCOL_VERSION,
        ...input,
    };
}
