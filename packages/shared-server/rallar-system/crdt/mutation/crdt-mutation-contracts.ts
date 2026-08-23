import type {
    RallarCrdtAppendResult,
    RallarCrdtAuditEvent,
    RallarCrdtAuthorizationScope,
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
    RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { AppInboxType } from '../../app-inbox/app-inbox-contracts.ts';

export const CRDT_MUTATION_INBOX_TYPES = [
    AppInboxType.CRDT_UPDATE_APPEND,
    AppInboxType.CRDT_PROJECTION_REBUILD,
    AppInboxType.CRDT_SNAPSHOT_COMPACT,
    AppInboxType.CRDT_LIFECYCLE_UPDATE,
    AppInboxType.CRDT_ERASE
] as const;

export interface CrdtMutationActor {
    readonly actorId: string;
    readonly principalId: string;
    readonly sessionId: string;
    readonly serverId: string;
}

export interface CrdtMutationResponseAudience {
    readonly kind: 'room' | 'principal' | 'app' | 'admin';
    readonly senderSessionId: string;
    readonly topicId: string;
    readonly contextId: string;
}

export type CrdtCanonicalSnapshotEnvelope =
    & Omit<RallarCrdtSnapshotEnvelope, 'metadata'>
    & Readonly<{
        metadata: RallarCrdtSnapshotEnvelope['metadata'] & Readonly<{ reason: string; }>;
    }>;

interface CrdtMutationCommandBase {
    readonly version: 1;
    readonly commandId: string;
    readonly deliveryId: string;
    readonly commandHash: string;
    readonly actor: CrdtMutationActor;
    readonly capturedAtEpochMs: number;
    readonly expireAtEpochMs: number;
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly responseAudience: CrdtMutationResponseAudience;
}

export interface CrdtAppendCommand extends CrdtMutationCommandBase {
    readonly operation: 'append';
    readonly update: RallarCrdtUpdateEnvelope;
    readonly authorizationScope: RallarCrdtAuthorizationScope;
}

export interface CrdtProjectionRebuildCommand extends CrdtMutationCommandBase {
    readonly operation: 'rebuild-projection';
    readonly projectionId: string;
}

export interface CrdtSnapshotCompactCommand extends CrdtMutationCommandBase {
    readonly operation: 'compact';
    readonly snapshotId: string;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
    readonly reason: string;
}

export interface CrdtLifecycleCommand extends CrdtMutationCommandBase {
    readonly operation: 'lifecycle';
    readonly lifecycle: RallarCrdtDocumentLifecycleState;
    readonly retentionAction: CrdtLifecycleFieldAction<RallarCrdtRetentionPolicy>;
    readonly quotaAction: CrdtLifecycleFieldAction<RallarCrdtQuotaPolicy>;
    readonly projectionIdsAction: CrdtLifecycleFieldAction<readonly string[]>;
}

export type CrdtLifecycleFieldAction<T> =
    | Readonly<{ kind: 'preserve'; }>
    | Readonly<{ kind: 'clear'; }>
    | Readonly<{ kind: 'set'; value: T; }>;

export interface CrdtEraseCommand extends CrdtMutationCommandBase {
    readonly operation: 'erase';
    readonly mode: 'destroy-document' | 'redact-payloads';
    readonly reason: string;
}

export type CrdtMutationCommand =
    | CrdtAppendCommand
    | CrdtProjectionRebuildCommand
    | CrdtSnapshotCompactCommand
    | CrdtLifecycleCommand
    | CrdtEraseCommand;

type CreateCrdtMutationCommandVariant<T> =
    & Omit<T, 'version' | 'commandHash' | 'documentKey' | 'deliveryId'>
    & Readonly<{ deliveryId?: string; }>;

type CreateCrdtSnapshotCompactCommandInput =
    & Omit<CreateCrdtMutationCommandVariant<CrdtSnapshotCompactCommand>, 'snapshot'>
    & Readonly<{ snapshot: RallarCrdtSnapshotEnvelope | null; }>;

export type CreateCrdtMutationCommandInput =
    | CreateCrdtMutationCommandVariant<CrdtAppendCommand>
    | CreateCrdtMutationCommandVariant<CrdtProjectionRebuildCommand>
    | CreateCrdtSnapshotCompactCommandInput
    | CreateCrdtMutationCommandVariant<CrdtLifecycleCommand>
    | CreateCrdtMutationCommandVariant<CrdtEraseCommand>;

export interface CrdtMutationRead {
    readonly document: RallarCrdtDocumentMetadata | null;
    readonly existingUpdate: RallarCrdtUpdateEnvelope | null;
    readonly existingAppend: RallarCrdtTrustedAppendMetadata | null;
    readonly records: readonly RallarCrdtDurableUpdateRecord[];
    readonly snapshot: RallarCrdtSnapshotEnvelope | null;
    readonly authorized: boolean;
    readonly authorizationCode: string;
    readonly featureDecision: RallarCrdtFeatureDecision;
    readonly actorUpdatesInWindow: number;
    readonly storedSnapshotBytes: number;
}

export interface CrdtMutationAttemptFacts {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
}

interface CrdtMutationComputedBase {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly operation: CrdtMutationCommand['operation'];
    readonly commandId: string;
    readonly commandHash: string;
    readonly documentKey: string;
    readonly expectedDocumentRevision: number | 'absent';
    readonly expectedDocumentLifecycle: RallarCrdtDocumentLifecycleState | 'absent';
    readonly expectedAppendSequence: number | 'absent';
    readonly document: RallarCrdtDocumentMetadata | null;
    readonly update: RallarCrdtUpdateEnvelope | null;
    readonly append: RallarCrdtTrustedAppendMetadata | null;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
    readonly outboxEntries: readonly ResourceEntry[];
    readonly result: CrdtMutationResult;
}

export interface CrdtMutationComputedWrite extends CrdtMutationComputedBase {
    readonly outcome: 'write';
    readonly document: RallarCrdtDocumentMetadata;
}

export interface CrdtMutationComputedReplay extends CrdtMutationComputedBase {
    readonly outcome: 'replay';
}

export interface CrdtMutationComputedRejected extends CrdtMutationComputedBase {
    readonly outcome: 'rejected';
    readonly code: string;
}
export type CrdtMutationComputed =
    | CrdtMutationComputedWrite
    | CrdtMutationComputedReplay
    | CrdtMutationComputedRejected;

export interface ValidateCrdtMutationInput extends CrdtMutationAttemptFacts {
    readonly computed: CrdtMutationComputed;
}

export interface CrdtMutationValidationIssue {
    readonly code: string;
    readonly message: string;
}

interface CrdtAcceptedMutationResultBase<TOperation extends CrdtMutationCommand['operation']> {
    readonly version: 1;
    readonly operation: TOperation;
    readonly status: 'accepted';
    readonly commandId: string;
    readonly documentKey: string;
    readonly documentRevision: number;
    readonly appendSequence: number;
    readonly code: null;
}

interface CrdtReplayMutationResultBase<TOperation extends CrdtMutationCommand['operation']> {
    readonly version: 1;
    readonly operation: TOperation;
    readonly status: 'replay';
    readonly commandId: string;
    readonly documentKey: string;
    readonly documentRevision: number;
    readonly appendSequence: number;
    readonly code: null;
}

interface CrdtRejectedMutationResultBase<TOperation extends CrdtMutationCommand['operation']> {
    readonly version: 1;
    readonly operation: TOperation;
    readonly status: 'rejected';
    readonly commandId: string;
    readonly documentKey: string;
    readonly documentRevision: number | null;
    readonly appendSequence: null;
    readonly code: string;
}

export type CrdtAppendMutationResult =
    | (
        & CrdtAcceptedMutationResultBase<'append'>
        & Readonly<{
            operation: 'append';
            appendResult: Extract<RallarCrdtAppendResult, { status: 'accepted'; }>;
        }>
    )
    | (
        & CrdtReplayMutationResultBase<'append'>
        & Readonly<{
            appendResult: Extract<RallarCrdtAppendResult, { status: 'duplicate'; }>;
        }>
    )
    | (
        & CrdtRejectedMutationResultBase<'append'>
        & Readonly<{
            appendResult: Extract<RallarCrdtAppendResult, { status: 'rejected'; }>;
        }>
    );

export type CrdtCompactMutationResult =
    | (
        & CrdtAcceptedMutationResultBase<'compact'>
        & Readonly<{
            snapshot: CrdtCanonicalSnapshotEnvelope;
            metadata: RallarCrdtDocumentMetadata;
        }>
    )
    | (
        & CrdtRejectedMutationResultBase<'compact'>
        & Readonly<{
            snapshot: null;
            metadata: null;
        }>
    );

export type CrdtLifecycleMutationResult =
    | (
        & CrdtAcceptedMutationResultBase<'lifecycle'>
        & Readonly<{
            metadata: RallarCrdtDocumentMetadata;
        }>
    )
    | (
        & CrdtRejectedMutationResultBase<'lifecycle'>
        & Readonly<{
            metadata: null;
        }>
    );

export type CrdtRebuildMutationResult =
    | (
        & CrdtAcceptedMutationResultBase<'rebuild-projection'>
        & Readonly<{
            integrity: RallarCrdtIntegrityReport;
            metadata: RallarCrdtDocumentMetadata;
        }>
    )
    | (
        & CrdtRejectedMutationResultBase<'rebuild-projection'>
        & Readonly<{
            integrity: null;
            metadata: null;
        }>
    );

export type CrdtEraseMutationResult =
    | (
        & CrdtAcceptedMutationResultBase<'erase'>
        & Readonly<{
            request: RallarCrdtErasureRequest;
            auditEvent: RallarCrdtAuditEvent;
            metadata: RallarCrdtDocumentMetadata;
            redactedBundle: RallarCrdtDebugBundle | null;
        }>
    )
    | (
        & CrdtRejectedMutationResultBase<'erase'>
        & Readonly<{
            request: null;
            auditEvent: null;
            metadata: null;
            redactedBundle: null;
        }>
    );

export type CrdtMutationResult =
    | CrdtAppendMutationResult
    | CrdtCompactMutationResult
    | CrdtLifecycleMutationResult
    | CrdtRebuildMutationResult
    | CrdtEraseMutationResult;

export interface CrdtAdminCompactResult {
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly appendSequence: number;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope;
}

export type CrdtAdminEraseResult =
    | Readonly<{
        request: RallarCrdtErasureRequest;
        auditEvent: RallarCrdtAuditEvent;
        metadata: RallarCrdtDocumentMetadata;
    }>
    | Readonly<{
        request: RallarCrdtErasureRequest;
        auditEvent: RallarCrdtAuditEvent;
        redactedBundle: RallarCrdtDebugBundle;
    }>;

export interface CrdtMutationRepository {
    readonly readMutation: (command: CrdtMutationCommand) => Promise<CrdtMutationRead>;
    readonly writeMutation: (computed: CrdtMutationComputedWrite) => Promise<void>;
    readonly writeOutbox: (entries: readonly ResourceEntry[]) => Promise<void>;
}

export class CrdtMutationConflictError extends Error {
    readonly code = 'crdt-mutation-write-conflict';
    readonly status = 503;

    readonly documentKey: string;

    constructor(documentKey: string) {
        super(`CRDT document predecessor changed: ${documentKey}`);
        this.documentKey = documentKey;
        this.name = 'CrdtMutationConflictError';
    }
}
