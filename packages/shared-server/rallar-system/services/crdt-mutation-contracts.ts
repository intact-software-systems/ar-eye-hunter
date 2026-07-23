import type {
    RallarCrdtAuthorizationScope,
    RallarCrdtAppendResult,
    RallarCrdtAuditEvent,
    RallarCrdtDebugBundle,
    RallarCrdtDocumentLifecycleState,
    RallarCrdtDocumentMetadata,
    RallarCrdtDocumentRef,
    RallarCrdtDurableUpdateRecord,
    RallarCrdtErasureRequest,
    RallarCrdtFeatureDecision,
    RallarCrdtIntegrityReport,
    RallarCrdtQuotaPolicy,
    RallarCrdtRetentionPolicy,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtTrustedAppendMetadata,
    RallarCrdtUpdateEnvelope,
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { AppInboxType } from './app-inbox-contracts.ts';

export const CRDT_MUTATION_INBOX_TYPES = [
    AppInboxType.CRDT_UPDATE_APPEND,
    AppInboxType.CRDT_PROJECTION_REBUILD,
    AppInboxType.CRDT_SNAPSHOT_COMPACT,
    AppInboxType.CRDT_LIFECYCLE_UPDATE,
    AppInboxType.CRDT_ERASE,
] as const;

export type CrdtMutationActor = Readonly<{
    actorId: string;
    principalId: string;
    sessionId: string;
    serverId: string;
}>;

export type CrdtMutationResponseAudience = Readonly<{
    kind: 'room' | 'principal' | 'app' | 'admin';
    senderSessionId: string;
    topicId: string;
    contextId: string;
}>;

type CrdtMutationCommandBase = Readonly<{
    version: 1;
    commandId: string;
    commandHash: string;
    actor: CrdtMutationActor;
    capturedAtEpochMs: number;
    expireAtEpochMs: number;
    document: RallarCrdtDocumentRef;
    documentKey: string;
    responseAudience: CrdtMutationResponseAudience;
}>;

export type CrdtAppendCommand = CrdtMutationCommandBase & Readonly<{
    operation: 'append';
    update: RallarCrdtUpdateEnvelope;
    authorizationScope: RallarCrdtAuthorizationScope;
}>;

export type CrdtProjectionRebuildCommand = CrdtMutationCommandBase & Readonly<{
    operation: 'rebuild-projection';
    projectionId: string;
}>;

export type CrdtSnapshotCompactCommand = CrdtMutationCommandBase & Readonly<{
    operation: 'compact';
    snapshot: RallarCrdtSnapshotEnvelope | null;
    reason: string;
}>;

export type CrdtLifecycleCommand = CrdtMutationCommandBase & Readonly<{
    operation: 'lifecycle';
    lifecycle: RallarCrdtDocumentLifecycleState;
    retention: RallarCrdtRetentionPolicy | null;
    quota: RallarCrdtQuotaPolicy | null;
    projectionIds: readonly string[];
}>;

export type CrdtEraseCommand = CrdtMutationCommandBase & Readonly<{
    operation: 'erase';
    mode: 'destroy-document' | 'redact-payloads';
    reason: string;
}>;

export type CrdtMutationCommand =
    | CrdtAppendCommand
    | CrdtProjectionRebuildCommand
    | CrdtSnapshotCompactCommand
    | CrdtLifecycleCommand
    | CrdtEraseCommand;

export type CreateCrdtMutationCommandInput =
    | Omit<CrdtAppendCommand, 'version' | 'commandHash' | 'documentKey'>
    | Omit<CrdtProjectionRebuildCommand, 'version' | 'commandHash' | 'documentKey'>
    | Omit<CrdtSnapshotCompactCommand, 'version' | 'commandHash' | 'documentKey'>
    | Omit<CrdtLifecycleCommand, 'version' | 'commandHash' | 'documentKey'>
    | Omit<CrdtEraseCommand, 'version' | 'commandHash' | 'documentKey'>;

export type CrdtMutationRead = Readonly<{
    document: RallarCrdtDocumentMetadata | null;
    existingUpdate: RallarCrdtUpdateEnvelope | null;
    existingAppend: RallarCrdtTrustedAppendMetadata | null;
    records: readonly RallarCrdtDurableUpdateRecord[];
    snapshot: RallarCrdtSnapshotEnvelope | null;
    authorized: boolean;
    authorizationCode: string;
    featureDecision: RallarCrdtFeatureDecision;
    actorUpdatesInWindow: number;
    storedSnapshotBytes: number;
}>;

type CrdtMutationComputedBase = Readonly<{
    operation: CrdtMutationCommand['operation'];
    commandId: string;
    commandHash: string;
    documentKey: string;
    expectedDocumentRevision: number | 'absent';
    expectedDocumentLifecycle: RallarCrdtDocumentLifecycleState | 'absent';
    expectedAppendSequence: number | 'absent';
    document: RallarCrdtDocumentMetadata | null;
    update: RallarCrdtUpdateEnvelope | null;
    append: RallarCrdtTrustedAppendMetadata | null;
    snapshot: RallarCrdtSnapshotEnvelope | null;
    outboxEntries: readonly ResourceEntry[];
    result: CrdtMutationResult;
}>;

export type CrdtMutationComputedWrite = CrdtMutationComputedBase & Readonly<{
    outcome: 'write';
    document: RallarCrdtDocumentMetadata;
}>;
export type CrdtMutationComputedReplay = CrdtMutationComputedBase & Readonly<{
    outcome: 'replay';
}>;
export type CrdtMutationComputedRejected = CrdtMutationComputedBase & Readonly<{
    outcome: 'rejected';
    code: string;
}>;
export type CrdtMutationComputed =
    | CrdtMutationComputedWrite
    | CrdtMutationComputedReplay
    | CrdtMutationComputedRejected;

type CrdtMutationResultBase = Readonly<{
    version: 1;
    operation: CrdtMutationCommand['operation'];
    status: 'accepted' | 'replay' | 'rejected';
    commandId: string;
    documentKey: string;
    documentRevision: number | null;
    appendSequence: number | null;
    code: string | null;
}>;

export type CrdtAppendMutationResult = CrdtMutationResultBase & Readonly<{
    operation: 'append';
    appendResult: RallarCrdtAppendResult;
}>;

export type CrdtCompactMutationResult = CrdtMutationResultBase & Readonly<{
    operation: 'compact';
    snapshot: RallarCrdtSnapshotEnvelope | null;
}>;

export type CrdtLifecycleMutationResult = CrdtMutationResultBase & Readonly<{
    operation: 'lifecycle';
    metadata: RallarCrdtDocumentMetadata | null;
}>;

export type CrdtRebuildMutationResult = CrdtMutationResultBase & Readonly<{
    operation: 'rebuild-projection';
    integrity: RallarCrdtIntegrityReport | null;
}>;

export type CrdtEraseMutationResult = CrdtMutationResultBase & Readonly<{
    operation: 'erase';
    request: RallarCrdtErasureRequest | null;
    auditEvent: RallarCrdtAuditEvent | null;
    metadata: RallarCrdtDocumentMetadata | null;
    redactedBundle: RallarCrdtDebugBundle | null;
}>;

export type CrdtMutationResult =
    | CrdtAppendMutationResult
    | CrdtCompactMutationResult
    | CrdtLifecycleMutationResult
    | CrdtRebuildMutationResult
    | CrdtEraseMutationResult;

export type CrdtMutationRepository = Readonly<{
    readMutation(command: CrdtMutationCommand): Promise<CrdtMutationRead>;
    writeMutation(computed: CrdtMutationComputedWrite): Promise<void>;
    writeOutbox(entries: readonly ResourceEntry[]): Promise<void>;
}>;

export class CrdtMutationConflictError extends Error {
    readonly code = 'crdt-mutation-write-conflict';
    readonly status = 503;

    constructor(readonly documentKey: string) {
        super(`CRDT document predecessor changed: ${documentKey}`);
        this.name = 'CrdtMutationConflictError';
    }
}
