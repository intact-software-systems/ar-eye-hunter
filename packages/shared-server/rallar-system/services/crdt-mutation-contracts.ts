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

export type CrdtCanonicalSnapshotEnvelope =
  & Omit<RallarCrdtSnapshotEnvelope, 'metadata'>
  & Readonly<{
    metadata: RallarCrdtSnapshotEnvelope['metadata'] & Readonly<{ reason: string }>;
  }>;

type CrdtMutationCommandBase = Readonly<{
  version: 1;
  commandId: string;
  deliveryId: string;
  commandHash: string;
  actor: CrdtMutationActor;
  capturedAtEpochMs: number;
  expireAtEpochMs: number;
  document: RallarCrdtDocumentRef;
  documentKey: string;
  responseAudience: CrdtMutationResponseAudience;
}>;

export type CrdtAppendCommand =
  & CrdtMutationCommandBase
  & Readonly<{
    operation: 'append';
    update: RallarCrdtUpdateEnvelope;
    authorizationScope: RallarCrdtAuthorizationScope;
  }>;

export type CrdtProjectionRebuildCommand =
  & CrdtMutationCommandBase
  & Readonly<{
    operation: 'rebuild-projection';
    projectionId: string;
  }>;

export type CrdtSnapshotCompactCommand =
  & CrdtMutationCommandBase
  & Readonly<{
    operation: 'compact';
    snapshotId: string;
    snapshot: CrdtCanonicalSnapshotEnvelope | null;
    reason: string;
  }>;

export type CrdtLifecycleCommand =
  & CrdtMutationCommandBase
  & Readonly<{
    operation: 'lifecycle';
    lifecycle: RallarCrdtDocumentLifecycleState;
    retentionAction: CrdtLifecycleFieldAction<RallarCrdtRetentionPolicy>;
    quotaAction: CrdtLifecycleFieldAction<RallarCrdtQuotaPolicy>;
    projectionIdsAction: CrdtLifecycleFieldAction<readonly string[]>;
  }>;

export type CrdtLifecycleFieldAction<T> =
  | Readonly<{ kind: 'preserve' }>
  | Readonly<{ kind: 'clear' }>
  | Readonly<{ kind: 'set'; value: T }>;

export type CrdtEraseCommand =
  & CrdtMutationCommandBase
  & Readonly<{
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

type CreateCrdtMutationCommandVariant<T> =
  & Omit<T, 'version' | 'commandHash' | 'documentKey' | 'deliveryId'>
  & Readonly<{ deliveryId?: string }>;

type CreateCrdtSnapshotCompactCommandInput =
  & Omit<CreateCrdtMutationCommandVariant<CrdtSnapshotCompactCommand>, 'snapshot'>
  & Readonly<{ snapshot: RallarCrdtSnapshotEnvelope | null }>;

export type CreateCrdtMutationCommandInput =
  | CreateCrdtMutationCommandVariant<CrdtAppendCommand>
  | CreateCrdtMutationCommandVariant<CrdtProjectionRebuildCommand>
  | CreateCrdtSnapshotCompactCommandInput
  | CreateCrdtMutationCommandVariant<CrdtLifecycleCommand>
  | CreateCrdtMutationCommandVariant<CrdtEraseCommand>;

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
  snapshot: CrdtCanonicalSnapshotEnvelope | null;
  outboxEntries: readonly ResourceEntry[];
  result: CrdtMutationResult;
}>;

export type CrdtMutationComputedWrite =
  & CrdtMutationComputedBase
  & Readonly<{
    outcome: 'write';
    document: RallarCrdtDocumentMetadata;
  }>;
export type CrdtMutationComputedReplay =
  & CrdtMutationComputedBase
  & Readonly<{
    outcome: 'replay';
  }>;
export type CrdtMutationComputedRejected =
  & CrdtMutationComputedBase
  & Readonly<{
    outcome: 'rejected';
    code: string;
  }>;
export type CrdtMutationComputed =
  | CrdtMutationComputedWrite
  | CrdtMutationComputedReplay
  | CrdtMutationComputedRejected;

type CrdtAcceptedMutationResultBase<TOperation extends CrdtMutationCommand['operation']> = Readonly<{
  version: 1;
  operation: TOperation;
  status: 'accepted';
  commandId: string;
  documentKey: string;
  documentRevision: number;
  appendSequence: number;
  code: null;
}>;

type CrdtReplayMutationResultBase<TOperation extends CrdtMutationCommand['operation']> = Readonly<{
  version: 1;
  operation: TOperation;
  status: 'replay';
  commandId: string;
  documentKey: string;
  documentRevision: number;
  appendSequence: number;
  code: null;
}>;

type CrdtRejectedMutationResultBase<TOperation extends CrdtMutationCommand['operation']> = Readonly<{
  version: 1;
  operation: TOperation;
  status: 'rejected';
  commandId: string;
  documentKey: string;
  documentRevision: number | null;
  appendSequence: null;
  code: string;
}>;

export type CrdtAppendMutationResult =
  | CrdtAcceptedMutationResultBase<'append'> & Readonly<{
    operation: 'append';
    appendResult: Extract<RallarCrdtAppendResult, { status: 'accepted' }>;
  }>
  | CrdtReplayMutationResultBase<'append'> & Readonly<{
    appendResult: Extract<RallarCrdtAppendResult, { status: 'duplicate' }>;
  }>
  | CrdtRejectedMutationResultBase<'append'> & Readonly<{
    appendResult: Extract<RallarCrdtAppendResult, { status: 'rejected' }>;
  }>;

export type CrdtCompactMutationResult =
  | CrdtAcceptedMutationResultBase<'compact'> & Readonly<{
    snapshot: CrdtCanonicalSnapshotEnvelope;
    metadata: RallarCrdtDocumentMetadata;
  }>
  | CrdtRejectedMutationResultBase<'compact'> & Readonly<{
    snapshot: null;
    metadata: null;
  }>;

export type CrdtLifecycleMutationResult =
  | CrdtAcceptedMutationResultBase<'lifecycle'> & Readonly<{
    metadata: RallarCrdtDocumentMetadata;
  }>
  | CrdtRejectedMutationResultBase<'lifecycle'> & Readonly<{
    metadata: null;
  }>;

export type CrdtRebuildMutationResult =
  | CrdtAcceptedMutationResultBase<'rebuild-projection'> & Readonly<{
    integrity: RallarCrdtIntegrityReport;
    metadata: RallarCrdtDocumentMetadata;
  }>
  | CrdtRejectedMutationResultBase<'rebuild-projection'> & Readonly<{
    integrity: null;
    metadata: null;
  }>;

export type CrdtEraseMutationResult =
  | CrdtAcceptedMutationResultBase<'erase'> & Readonly<{
    request: RallarCrdtErasureRequest;
    auditEvent: RallarCrdtAuditEvent;
    metadata: RallarCrdtDocumentMetadata;
    redactedBundle: RallarCrdtDebugBundle | null;
  }>
  | CrdtRejectedMutationResultBase<'erase'> & Readonly<{
    request: null;
    auditEvent: null;
    metadata: null;
    redactedBundle: null;
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
