import type { ActorId, PrincipalId } from '../api/group-types.ts';
import { canonicalRallarCrdtDocumentRef, toRallarCrdtDocumentKey } from './crdt-document-key.ts';
import type {
    RallarCrdtAppendRejectionCode,
    RallarCrdtDocumentLifecycleState,
    RallarCrdtDocumentMetadata,
    RallarCrdtDurableUpdateRecord,
    RallarCrdtListUpdatesInput,
    RallarCrdtQuotaPolicy,
    RallarCrdtRetentionPolicy,
    RallarCrdtUpdateLogRepository,
    RallarCrdtUpdatePage
} from './crdt-durable-log.ts';
import { isRallarCrdtEncryptedOperationBatch } from './crdt-encryption.ts';
import { hashRallarCrdtJson, hashRallarCrdtUpdateEnvelope } from './crdt-hash.ts';
import { createRallarCrdtDocument } from './crdt-operations.ts';
import type {
    RallarCrdtDocumentHealth,
    RallarCrdtDocumentRef,
    RallarCrdtDocumentScope,
    RallarCrdtOperationBatch,
    RallarCrdtSnapshotEnvelope,
    RallarCrdtTransportStrategy,
    RallarCrdtUpdateEnvelope,
    RallarCrdtValidationIssue,
    RallarCrdtValidationResult
} from './crdt-types.ts';

export type RallarCrdtRolloutLabel =
    | 'disabled'
    | 'experimental-local'
    | 'experimental-live'
    | 'durable-beta'
    | 'production';

export type RallarCrdtConsistencyPhase = 'local-only' | 'topic-bridge' | 'durable-log' | 'production';

export type RallarCrdtHardeningErrorCategory =
    | 'retryable.transport'
    | 'retryable.server'
    | 'permanent.authorization'
    | 'permanent.schema'
    | 'permanent.validation'
    | 'permanent.quota'
    | 'blocked.dependency'
    | 'corrupt.local-state'
    | 'corrupt.server-state';

export type RallarCrdtFeatureOperation =
    | 'open'
    | 'local-apply'
    | 'network-send'
    | 'ws-send'
    | 'rtc-send'
    | 'durable-append'
    | 'durable-catch-up'
    | 'peer-catch-up'
    | 'admin-export'
    | 'projection-rebuild';

export type RallarCrdtFeatureDecisionCode =
    | 'allowed'
    | 'feature-disabled'
    | 'rollout-disabled'
    | 'document-read-only'
    | 'rtc-disabled'
    | 'ws-disabled'
    | 'network-disabled'
    | 'durable-append-disabled'
    | 'peer-catch-up-disabled'
    | 'app-scope-disabled'
    | 'custom-scope-disabled'
    | 'graph-disabled'
    | 'sequence-text-disabled';

export interface RallarCrdtFeatureFlags {
    readonly networkSend?: boolean;
    readonly ws?: boolean;
    readonly rtc?: boolean;
    readonly durableAppend?: boolean;
    readonly peerCatchUp?: boolean;
    readonly readOnly?: boolean;
    readonly appScope?: boolean;
    readonly customScope?: boolean;
    readonly graphDocuments?: boolean;
    readonly sequenceTextDocuments?: boolean;
    readonly killSwitchReason?: string;
}

export interface RallarCrdtDocumentTypePolicy {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: RallarCrdtDocumentScope | 'any';
    readonly documentType: string | '*';
    readonly rollout: RallarCrdtRolloutLabel;
    readonly flags?: RallarCrdtFeatureFlags;
    readonly quota?: RallarCrdtQuotaPolicy;
    readonly retention?: RallarCrdtRetentionPolicy;
    readonly sensitiveFields?: readonly string[];
}

export interface RallarCrdtFeatureDecision {
    readonly allowed: boolean;
    readonly code: RallarCrdtFeatureDecisionCode;
    readonly reason: string;
    readonly rollout: RallarCrdtRolloutLabel;
    readonly retryable: boolean;
    readonly policy?: RallarCrdtDocumentTypePolicy;
}

export interface RallarCrdtFeaturePolicyInput {
    readonly document: RallarCrdtDocumentRef;
    readonly operation: RallarCrdtFeatureOperation;
    readonly policies?: readonly RallarCrdtDocumentTypePolicy[];
}

export interface RallarCrdtAdminDocumentStatus {
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly lifecycle: RallarCrdtDocumentLifecycleState;
    readonly rollout: RallarCrdtRolloutLabel;
    readonly updateCount: number;
    readonly snapshotCount: number;
    readonly lastAppendSequence: number;
    readonly updatedAtEpochMs: number;
    readonly health?: RallarCrdtDocumentHealth;
    readonly retention?: RallarCrdtRetentionPolicy;
    readonly quota?: RallarCrdtQuotaPolicy;
    readonly quarantineReason?: string;
}

export interface RallarCrdtListDocumentsInput {
    readonly applicationId?: string;
    readonly workspaceId?: string;
    readonly scope?: RallarCrdtDocumentScope;
    readonly documentType?: string;
    readonly lifecycle?: RallarCrdtDocumentLifecycleState;
    readonly limit?: number;
    readonly cursor?: string;
}

export interface RallarCrdtDocumentAdminPage {
    readonly documents: readonly RallarCrdtAdminDocumentStatus[];
    readonly nextCursor?: string;
    readonly hasMore: boolean;
}

export type RallarCrdtMetricName =
    | 'crdt.local.apply.ms'
    | 'crdt.merge.replay.ms'
    | 'crdt.convergence.ms'
    | 'crdt.pending.age.ms'
    | 'crdt.pending.failed.count'
    | 'crdt.dependency.blocked.count'
    | 'crdt.server.append.ms'
    | 'crdt.server.append.rejected.count'
    | 'crdt.sync.bytes'
    | 'crdt.catchup.page.count'
    | 'crdt.snapshot.bytes'
    | 'crdt.snapshot.age.ms'
    | 'crdt.update_log.count'
    | 'crdt.rtc.fallback.count';

export interface RallarCrdtMetricEvent {
    readonly name: RallarCrdtMetricName;
    readonly value: number;
    readonly atEpochMs: number;
    readonly documentKey?: string;
    readonly tags?: Readonly<Record<string, string>>;
}

export interface RallarCrdtMetricsSink {
    readonly record: (event: RallarCrdtMetricEvent) => void | Promise<void>;
}

export class InMemoryRallarCrdtMetricsSink implements RallarCrdtMetricsSink {
    private readonly recorded: RallarCrdtMetricEvent[] = [];

    public record(event: RallarCrdtMetricEvent): void {
        this.recorded.push(event);
    }

    public events(): readonly RallarCrdtMetricEvent[] {
        return [...this.recorded];
    }

    public count(name: RallarCrdtMetricName): number {
        return this.recorded.filter((event) => event.name === name).length;
    }
}

export type RallarCrdtAuditEventKind =
    | 'append'
    | 'reject'
    | 'export'
    | 'backup'
    | 'restore'
    | 'archive'
    | 'quarantine'
    | 'destroy'
    | 'erase'
    | 'redact'
    | 'rebuild'
    | 'compact';

export interface RallarCrdtAuditEvent {
    readonly kind: RallarCrdtAuditEventKind;
    readonly atEpochMs: number;
    readonly documentKey?: string;
    readonly actorId?: ActorId;
    readonly principalId?: PrincipalId;
    readonly reason?: string;
    readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface RallarCrdtAuditSink {
    readonly record: (event: RallarCrdtAuditEvent) => void | Promise<void>;
}

export class InMemoryRallarCrdtAuditSink implements RallarCrdtAuditSink {
    private readonly recorded: RallarCrdtAuditEvent[] = [];

    public record(event: RallarCrdtAuditEvent): void {
        this.recorded.push(event);
    }

    public events(): readonly RallarCrdtAuditEvent[] {
        return [...this.recorded];
    }

    public count(kind: RallarCrdtAuditEventKind): number {
        return this.recorded.filter((event) => event.kind === kind).length;
    }
}

export interface RallarCrdtDebugBundleRedaction {
    readonly payloadsRedacted: boolean;
    readonly sensitiveFields?: readonly string[];
    readonly reason?: string;
}

export interface RallarCrdtDebugBundle<TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch> {
    readonly format: 'rallar.crdt.debug-bundle.v1';
    readonly exportedAtEpochMs: number;
    readonly reason: string;
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly metadata?: RallarCrdtDocumentMetadata;
    readonly snapshot?: RallarCrdtSnapshotEnvelope;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    readonly health?: RallarCrdtDocumentHealth;
    readonly redaction: RallarCrdtDebugBundleRedaction;
    readonly integrity: RallarCrdtBundleIntegrity;
}

export interface RallarCrdtBundleIntegrity {
    readonly bundleHash: string;
    readonly documentRefHash: string;
    readonly snapshotHash?: string;
    readonly updateHashes: Readonly<Record<string, string>>;
    readonly firstAppendSequence?: number;
    readonly lastAppendSequence?: number;
    readonly updateCount: number;
    readonly sequenceGaps: readonly number[];
}

export interface RallarCrdtIntegrityReport extends RallarCrdtValidationResult {
    readonly documentKey: string;
    readonly checkedUpdateCount: number;
    readonly sequenceGaps: readonly number[];
    readonly bundleHash?: string;
}

export interface RallarCrdtBackupBundle<TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch> {
    readonly format: 'rallar.crdt.backup-bundle.v1';
    readonly exportedAtEpochMs: number;
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly metadata: RallarCrdtDocumentMetadata;
    readonly snapshot?: RallarCrdtSnapshotEnvelope;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    readonly integrity: RallarCrdtBundleIntegrity;
}

export interface RallarCrdtRestoreResult {
    readonly document: RallarCrdtDocumentRef;
    readonly documentKey: string;
    readonly restoredUpdateCount: number;
    readonly restoredSnapshot: boolean;
    readonly firstAppendSequence?: number;
    readonly lastAppendSequence?: number;
}

export interface RallarCrdtDebugBundleExportOptions {
    readonly reason?: string;
    readonly exportedAtEpochMs?: number;
    readonly redaction?: RallarCrdtDebugBundleRedaction;
}

export interface RallarCrdtBackupBundleExportOptions {
    readonly exportedAtEpochMs?: number;
}

export interface RallarCrdtRestoreBackupBundleOptions {
    readonly overwrite?: boolean;
}

export interface RallarCrdtAdminReadRepository<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    TValue = RallarCrdtSnapshotEnvelope['value'],
> {
    listAfter(input: RallarCrdtListUpdatesInput): Promise<RallarCrdtUpdatePage<TPayload>>;
    readSnapshot(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtSnapshotEnvelope<TValue> | undefined>;
    readDocumentMetadata(
        document: RallarCrdtDocumentRef
    ): Promise<RallarCrdtDocumentMetadata | undefined>;
    listDocuments(input?: RallarCrdtListDocumentsInput): Promise<RallarCrdtDocumentAdminPage>;
    exportDebugBundle(
        document: RallarCrdtDocumentRef,
        options?: RallarCrdtDebugBundleExportOptions
    ): Promise<RallarCrdtDebugBundle<TPayload>>;
    exportBackupBundle(
        document: RallarCrdtDocumentRef,
        options?: RallarCrdtBackupBundleExportOptions
    ): Promise<RallarCrdtBackupBundle<TPayload> | undefined>;
    verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport>;
}

export interface RallarCrdtAdminLogRepository<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
    TValue = RallarCrdtSnapshotEnvelope['value'],
> extends RallarCrdtUpdateLogRepository<TPayload, TValue> {
    listDocuments(input?: RallarCrdtListDocumentsInput): Promise<RallarCrdtDocumentAdminPage>;
    exportDebugBundle(
        document: RallarCrdtDocumentRef,
        options?: RallarCrdtDebugBundleExportOptions
    ): Promise<RallarCrdtDebugBundle<TPayload>>;
    exportBackupBundle(
        document: RallarCrdtDocumentRef,
        options?: RallarCrdtBackupBundleExportOptions
    ): Promise<RallarCrdtBackupBundle<TPayload> | undefined>;
    restoreBackupBundle(
        bundle: RallarCrdtBackupBundle<TPayload>,
        options?: RallarCrdtRestoreBackupBundleOptions
    ): Promise<RallarCrdtRestoreResult>;
    verifyIntegrity(document: RallarCrdtDocumentRef): Promise<RallarCrdtIntegrityReport>;
    rebuildProjection(
        document: RallarCrdtDocumentRef,
        projectionId?: string
    ): Promise<RallarCrdtIntegrityReport>;
}

export interface RallarCrdtSpatialMetadata {
    readonly coordinateFrameId: string;
    readonly coordinateFrameVersion: string;
    readonly anchorRef?: string;
    readonly calibrationVersion?: string;
    readonly source?: string;
    readonly transformProvenance?: string;
    readonly confidence?: number;
    readonly accuracyMeters?: number;
}

export interface RallarCrdtDomainFollowUpPlan {
    readonly kind: 'sequence-text' | 'document-encryption' | 'ar-spatial';
    readonly required: boolean;
    readonly reason: string;
    readonly candidateDocumentTypes?: readonly string[];
    readonly blockedBy?: readonly string[];
}

export interface RallarCrdtRetentionStatus {
    readonly state: 'ok' | 'retention-due' | 'expired';
    readonly dueAtEpochMs?: number;
    readonly reason?: string;
}

export interface RallarCrdtErasureRequest {
    readonly document: RallarCrdtDocumentRef;
    readonly requestedAtEpochMs: number;
    readonly requestedBy: PrincipalId;
    readonly reason: string;
    readonly mode: 'destroy-document' | 'redact-payloads';
}

export interface RallarCrdtEncryptionMetadata {
    readonly enabled: boolean;
    readonly algorithm?: string;
    readonly keyId?: string;
    readonly payloadEncrypted?: boolean;
    readonly snapshotEncrypted?: boolean;
    readonly visibleMetadataFields?: readonly string[];
}

export type RallarCrdtDestructiveCompactionSafetyCode =
    | 'safe'
    | 'no-snapshot'
    | 'legacy-snapshot'
    | 'missing-crdt-state'
    | 'append-sequence-gap'
    | 'snapshot-includes-unknown-update'
    | 'no-compactable-updates'
    | 'encrypted-log-requires-key-authorized-snapshot';

export interface RallarCrdtDestructiveCompactionSafety {
    readonly safe: boolean;
    readonly code: RallarCrdtDestructiveCompactionSafetyCode;
    readonly reason: string;
    readonly compactableUpdateIds: readonly string[];
}

export interface RallarCrdtScheduledHealthStatus {
    readonly documentKey: string;
    readonly lifecycle: RallarCrdtDocumentLifecycleState;
    readonly updateCount: number;
    readonly snapshotCount: number;
    readonly retention: RallarCrdtRetentionStatus;
    readonly staleSnapshot: boolean;
    readonly alert: 'clean' | 'warn' | 'critical';
}

export interface RallarCrdtScheduledHealthSummary {
    readonly checkedAtEpochMs: number;
    readonly total: number;
    readonly unhealthy: number;
    readonly quarantined: number;
    readonly retentionDue: number;
    readonly expired: number;
    readonly staleSnapshots: number;
    readonly documents: readonly RallarCrdtScheduledHealthStatus[];
}

export function evaluateRallarCrdtFeaturePolicy(
    input: RallarCrdtFeaturePolicyInput
): RallarCrdtFeatureDecision {
    const policy = selectRallarCrdtDocumentTypePolicy(input.document, input.policies ?? []);
    const rollout = policy?.rollout ?? 'production';
    const flags = policy?.flags;
    const disabledReason = flags?.killSwitchReason ?? 'CRDT document type is disabled by rollout policy.';

    if (rollout === 'disabled') {
        return deny({ code: 'rollout-disabled', reason: disabledReason, rollout, policy });
    }

    if (input.document.scope === 'app' && flags?.appScope === false) {
        return deny({
            code: 'app-scope-disabled',
            reason: 'App-scoped CRDT documents are disabled by policy.',
            rollout,
            policy
        });
    }
    if (input.document.scope === 'custom' && flags?.customScope === false) {
        return deny({
            code: 'custom-scope-disabled',
            reason: 'Custom-scoped CRDT documents are disabled by policy.',
            rollout,
            policy
        });
    }

    if (
        flags?.readOnly &&
        ['local-apply', 'network-send', 'ws-send', 'rtc-send', 'durable-append'].includes(
            input.operation
        )
    ) {
        return deny({
            code: 'document-read-only',
            reason: 'CRDT document is forced read-only by policy.',
            rollout,
            policy
        });
    }

    if (
        flags?.networkSend === false &&
        ['network-send', 'ws-send', 'rtc-send'].includes(input.operation)
    ) {
        return deny({
            code: 'network-disabled',
            reason: 'CRDT network send is disabled by policy.',
            rollout,
            policy
        });
    }
    if (flags?.ws === false && input.operation === 'ws-send') {
        return deny({
            code: 'ws-disabled',
            reason: 'CRDT WS send is disabled by policy.',
            rollout,
            policy
        });
    }
    if (flags?.rtc === false && input.operation === 'rtc-send') {
        return deny({
            code: 'rtc-disabled',
            reason: 'CRDT RTC send is disabled by policy.',
            rollout,
            policy
        });
    }
    if (
        flags?.durableAppend === false &&
        (input.operation === 'durable-append' || input.operation === 'durable-catch-up')
    ) {
        return deny({
            code: 'durable-append-disabled',
            reason: 'CRDT durable append is disabled by policy.',
            rollout,
            policy
        });
    }
    if (flags?.peerCatchUp === false && input.operation === 'peer-catch-up') {
        return deny({
            code: 'peer-catch-up-disabled',
            reason: 'CRDT peer catch-up is disabled by policy.',
            rollout,
            policy
        });
    }
    if (flags?.graphDocuments === false && input.document.documentType === 'graph') {
        return deny({
            code: 'graph-disabled',
            reason: 'Graph CRDT documents are disabled by policy.',
            rollout,
            policy
        });
    }
    if (
        flags?.sequenceTextDocuments === false &&
        ['text', 'rich-text', 'sequence'].includes(input.document.documentType)
    ) {
        return deny({
            code: 'sequence-text-disabled',
            reason: 'Sequence/text CRDT documents are disabled by policy.',
            rollout,
            policy
        });
    }

    return {
        allowed: true,
        code: 'allowed',
        reason: 'CRDT operation is allowed by policy.',
        rollout,
        retryable: false,
        policy
    };
}

export function selectRallarCrdtDocumentTypePolicy(
    document: RallarCrdtDocumentRef,
    policies: readonly RallarCrdtDocumentTypePolicy[]
): RallarCrdtDocumentTypePolicy | undefined {
    return policies.find((policy) => {
        if (policy.applicationId !== undefined && policy.applicationId !== document.applicationId) {
            return false;
        }
        if (policy.workspaceId !== undefined && policy.workspaceId !== document.workspaceId) {
            return false;
        }
        if (policy.scope !== undefined && policy.scope !== 'any' && policy.scope !== document.scope) {
            return false;
        }
        return policy.documentType === '*' || policy.documentType === document.documentType;
    });
}

export interface CreateRallarCrdtAdminDocumentStatusInput {
    readonly metadata: RallarCrdtDocumentMetadata;
    readonly rollout?: RallarCrdtRolloutLabel;
    readonly health?: RallarCrdtDocumentHealth;
    readonly quarantineReason?: string;
}

export interface CreateRallarCrdtDebugBundleInput<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> {
    readonly exportedAtEpochMs: number;
    readonly reason: string;
    readonly document: RallarCrdtDocumentRef;
    readonly metadata?: RallarCrdtDocumentMetadata;
    readonly snapshot?: RallarCrdtSnapshotEnvelope;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    readonly health?: RallarCrdtDocumentHealth;
    readonly redaction?: RallarCrdtDebugBundleRedaction;
}

export interface CreateRallarCrdtCompactedSnapshotInput<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> {
    readonly document: RallarCrdtDocumentRef;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    readonly replicaId?: string;
    readonly reason?: string;
    readonly now?: () => number;
    readonly createSnapshotId?: () => string;
}

export interface EvaluateRallarCrdtDestructiveCompactionSafetyInput<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> {
    readonly snapshot?: RallarCrdtSnapshotEnvelope;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
    readonly allowEncryptedWithSuppliedState?: boolean;
}

export function createRallarCrdtAdminDocumentStatus(
    input: CreateRallarCrdtAdminDocumentStatusInput
): RallarCrdtAdminDocumentStatus {
    return {
        document: input.metadata.document,
        documentKey: input.metadata.documentKey,
        lifecycle: input.metadata.lifecycle,
        rollout: input.rollout ?? 'production',
        updateCount: input.metadata.updateCount,
        snapshotCount: input.metadata.snapshotCount,
        lastAppendSequence: input.metadata.lastAppendSequence,
        updatedAtEpochMs: input.metadata.updatedAtEpochMs,
        health: input.health,
        ...(input.metadata.retention === null ? {} : { retention: input.metadata.retention }),
        ...(input.metadata.quota === null ? {} : { quota: input.metadata.quota }),
        quarantineReason: input.quarantineReason
    };
}

export function createRallarCrdtDebugBundle<TPayload extends RallarCrdtOperationBatch>(
    input: CreateRallarCrdtDebugBundleInput<TPayload>
): RallarCrdtDebugBundle<TPayload> {
    const documentKey = toRallarCrdtDocumentKey(input.document);
    const redaction = input.redaction ?? {
        payloadsRedacted: false
    };
    const records = redaction.payloadsRedacted ? input.records.map(redactDebugRecord) : input.records;
    const withoutIntegrity = {
        format: 'rallar.crdt.debug-bundle.v1' as const,
        exportedAtEpochMs: input.exportedAtEpochMs,
        reason: input.reason,
        document: input.document,
        documentKey,
        metadata: input.metadata,
        snapshot: input.snapshot,
        records,
        health: input.health,
        redaction
    };
    return {
        ...withoutIntegrity,
        integrity: createBundleIntegrity(withoutIntegrity)
    };
}

export function createRallarCrdtCompactedSnapshot<
    TValue = RallarCrdtSnapshotEnvelope['value'],
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
>(input: CreateRallarCrdtCompactedSnapshotInput<TPayload>): RallarCrdtSnapshotEnvelope<TValue> {
    if (input.records.some((record) => isRallarCrdtEncryptedOperationBatch(record.update.payload))) {
        throw new Error(
            'Cannot server-compact encrypted CRDT logs without a supplied compact snapshot.'
        );
    }

    const document = createRallarCrdtDocument<TValue, TPayload>({
        ref: input.document,
        replicaId: input.replicaId ?? 'rallar-crdt-compactor',
        now: input.now,
        createSnapshotId: input.createSnapshotId
    });

    for (
        const record of [...input.records].sort(
            (left, right) => left.append.appendSequence - right.append.appendSequence
        )
    ) {
        document.apply(record.update);
    }

    return document.snapshot(input.reason ?? 'non-destructive-compaction');
}

export function evaluateRallarCrdtDestructiveCompactionSafety<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
>(
    input: EvaluateRallarCrdtDestructiveCompactionSafetyInput<TPayload>
): RallarCrdtDestructiveCompactionSafety {
    const snapshot = input.snapshot;
    if (!snapshot) {
        return destructiveCompactionBlocked(
            'no-snapshot',
            'Destructive CRDT compaction requires a compact snapshot boundary.'
        );
    }
    if (snapshot.metadata.unsafeLegacyCollectionCompaction) {
        return destructiveCompactionBlocked(
            'legacy-snapshot',
            'Legacy CRDT snapshots are not safe destructive compaction boundaries.'
        );
    }
    if (!snapshot.metadata.crdtState) {
        return destructiveCompactionBlocked(
            'missing-crdt-state',
            'Destructive CRDT compaction requires a snapshot CRDT-state sidecar.'
        );
    }

    const sequenceGaps = findAppendSequenceGaps(input.records);
    if (sequenceGaps.length > 0) {
        return destructiveCompactionBlocked(
            'append-sequence-gap',
            'Destructive CRDT compaction requires contiguous append records.'
        );
    }

    const recordIds = new Set(input.records.map((record) => record.update.updateId));
    const unknownIncluded = snapshot.includedUpdateIds.find((updateId) => !recordIds.has(updateId));
    if (unknownIncluded) {
        return destructiveCompactionBlocked(
            'snapshot-includes-unknown-update',
            `Snapshot includes update ${unknownIncluded}, which is not present in the candidate records.`
        );
    }

    const compactableUpdateIds = input.records
        .filter((record) => snapshot.includedUpdateIds.includes(record.update.updateId))
        .map((record) => record.update.updateId)
        .sort();
    if (compactableUpdateIds.length === 0) {
        return destructiveCompactionBlocked(
            'no-compactable-updates',
            'Snapshot does not include any candidate records to compact.'
        );
    }

    const hasEncryptedRecords = input.records.some((record) =>
        isRallarCrdtEncryptedOperationBatch(record.update.payload)
    );
    if (hasEncryptedRecords && !input.allowEncryptedWithSuppliedState) {
        const reason = 'Encrypted CRDT logs require an explicit client/key-authorized compact snapshot ' +
            'before destructive compaction.';
        return destructiveCompactionBlocked('encrypted-log-requires-key-authorized-snapshot', reason);
    }

    return {
        safe: true,
        code: 'safe',
        reason: 'CRDT snapshot is a safe destructive compaction boundary for the included records.',
        compactableUpdateIds
    };
}

export function evaluateRallarCrdtRetentionStatus(
    metadata: RallarCrdtDocumentMetadata,
    nowEpochMs: number
): RallarCrdtRetentionStatus {
    const policy = metadata.retention;
    if (!policy || policy.mode === 'retain' || policy.ttlMs === undefined) {
        return {
            state: 'ok'
        };
    }

    const dueAtEpochMs = metadata.updatedAtEpochMs + policy.ttlMs;
    if (nowEpochMs < dueAtEpochMs) {
        return {
            state: 'ok',
            dueAtEpochMs,
            reason: policy.reason
        };
    }

    return {
        state: policy.mode === 'delete-after' ? 'expired' : 'retention-due',
        dueAtEpochMs,
        reason: policy.reason
    };
}

export function createRallarCrdtErasureAuditEvent(
    request: RallarCrdtErasureRequest
): RallarCrdtAuditEvent {
    return {
        kind: request.mode === 'destroy-document' ? 'erase' : 'redact',
        atEpochMs: request.requestedAtEpochMs,
        documentKey: toRallarCrdtDocumentKey(request.document),
        principalId: request.requestedBy,
        reason: request.reason,
        metadata: {
            mode: request.mode
        }
    };
}

export interface SummarizeRallarCrdtScheduledHealthInput {
    readonly documents: readonly RallarCrdtDocumentMetadata[];
    readonly nowEpochMs: number;
    readonly staleSnapshotAfterMs?: number;
}

export function summarizeRallarCrdtScheduledHealth(
    input: SummarizeRallarCrdtScheduledHealthInput
): RallarCrdtScheduledHealthSummary {
    const staleSnapshotAfterMs = input.staleSnapshotAfterMs ?? 24 * 60 * 60 * 1_000;
    const documents = input.documents.map((metadata) => {
        const retention = evaluateRallarCrdtRetentionStatus(metadata, input.nowEpochMs);
        const staleSnapshot = metadata.updateCount > 0 &&
            metadata.snapshotCount === 0 &&
            input.nowEpochMs - metadata.updatedAtEpochMs >= staleSnapshotAfterMs;
        const alert: RallarCrdtScheduledHealthStatus['alert'] = metadata.lifecycle === 'quarantined' ||
                metadata.lifecycle === 'destroyed' ||
                retention.state === 'expired'
            ? 'critical'
            : staleSnapshot || retention.state === 'retention-due'
            ? 'warn'
            : 'clean';

        return {
            documentKey: metadata.documentKey,
            lifecycle: metadata.lifecycle,
            updateCount: metadata.updateCount,
            snapshotCount: metadata.snapshotCount,
            retention,
            staleSnapshot,
            alert
        };
    });

    return {
        checkedAtEpochMs: input.nowEpochMs,
        total: documents.length,
        unhealthy: documents.filter((document) => document.alert !== 'clean').length,
        quarantined: documents.filter((document) => document.lifecycle === 'quarantined').length,
        retentionDue: documents.filter((document) => document.retention.state === 'retention-due')
            .length,
        expired: documents.filter((document) => document.retention.state === 'expired').length,
        staleSnapshots: documents.filter((document) => document.staleSnapshot).length,
        documents
    };
}

export function validateRallarCrdtEncryptionMetadata(
    metadata: RallarCrdtEncryptionMetadata,
    path = '$'
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];
    if (!metadata.enabled) {
        return {
            valid: true,
            issues
        };
    }

    requireNonEmpty(metadata.algorithm, `${path}.algorithm`, issues);
    requireNonEmpty(metadata.keyId, `${path}.keyId`, issues);
    if (!metadata.payloadEncrypted && !metadata.snapshotEncrypted) {
        issues.push({
            path,
            code: 'missing-encrypted-surface',
            message: 'Encrypted CRDT metadata must mark payloads, snapshots, or both as encrypted.'
        });
    }

    return {
        valid: issues.length === 0,
        issues
    };
}

export interface CreateRallarCrdtBackupBundleInput<
    TPayload extends RallarCrdtOperationBatch = RallarCrdtOperationBatch,
> {
    readonly exportedAtEpochMs: number;
    readonly document: RallarCrdtDocumentRef;
    readonly metadata: RallarCrdtDocumentMetadata;
    readonly snapshot?: RallarCrdtSnapshotEnvelope;
    readonly records: readonly RallarCrdtDurableUpdateRecord<TPayload>[];
}

export function createRallarCrdtBackupBundle<TPayload extends RallarCrdtOperationBatch>(
    input: CreateRallarCrdtBackupBundleInput<TPayload>
): RallarCrdtBackupBundle<TPayload> {
    const documentKey = toRallarCrdtDocumentKey(input.document);
    const withoutIntegrity = {
        format: 'rallar.crdt.backup-bundle.v1' as const,
        exportedAtEpochMs: input.exportedAtEpochMs,
        document: input.document,
        documentKey,
        metadata: input.metadata,
        snapshot: input.snapshot,
        records: input.records
    };
    return {
        ...withoutIntegrity,
        integrity: createBundleIntegrity(withoutIntegrity)
    };
}

export function verifyRallarCrdtDebugBundle(
    bundle: RallarCrdtDebugBundle | RallarCrdtBackupBundle
): RallarCrdtIntegrityReport {
    const issues: RallarCrdtValidationIssue[] = [];
    const expectedDocumentKey = toRallarCrdtDocumentKey(bundle.document);

    if (bundle.documentKey !== expectedDocumentKey) {
        issues.push({
            path: '$.documentKey',
            code: 'document-key-mismatch',
            message: 'CRDT bundle documentKey does not match the document ref.'
        });
    }

    if (bundle.integrity.documentRefHash !== hashDocumentRef(bundle.document)) {
        issues.push({
            path: '$.integrity.documentRefHash',
            code: 'document-ref-hash-mismatch',
            message: 'CRDT bundle document ref hash does not match.'
        });
    }

    for (const record of bundle.records) {
        if (toRallarCrdtDocumentKey(record.update.document) !== expectedDocumentKey) {
            issues.push({
                path: `$.records.${record.update.updateId}.document`,
                code: 'record-document-mismatch',
                message: 'CRDT bundle record belongs to another document.'
            });
        }

        const actualHash = hashRallarCrdtUpdateEnvelope(record.update);
        const expectedHash = bundle.integrity.updateHashes[record.update.updateId];
        if (expectedHash !== actualHash) {
            issues.push({
                path: `$.integrity.updateHashes.${record.update.updateId}`,
                code: 'update-hash-mismatch',
                message: 'CRDT bundle update hash does not match the update envelope.'
            });
        }
        if (record.append.acceptedUpdateHash !== actualHash) {
            issues.push({
                path: `$.records.${record.update.updateId}.append.acceptedUpdateHash`,
                code: 'accepted-update-hash-mismatch',
                message: 'CRDT append metadata hash does not match the update envelope.'
            });
        }
    }

    const sequenceGaps = findAppendSequenceGaps(bundle.records);
    if (sequenceGaps.length > 0) {
        issues.push({
            path: '$.records',
            code: 'append-sequence-gap',
            message: 'CRDT bundle append sequences are not contiguous.'
        });
    }

    const expectedBundleHash = hashBundleWithoutHash(bundle);
    if (bundle.integrity.bundleHash !== expectedBundleHash) {
        issues.push({
            path: '$.integrity.bundleHash',
            code: 'bundle-hash-mismatch',
            message: 'CRDT bundle hash does not match bundle contents.'
        });
    }

    return {
        valid: issues.length === 0,
        issues,
        documentKey: expectedDocumentKey,
        checkedUpdateCount: bundle.records.length,
        sequenceGaps,
        bundleHash: expectedBundleHash
    };
}

export function validateRallarCrdtSpatialMetadata(
    metadata: Partial<RallarCrdtSpatialMetadata>,
    path = '$'
): RallarCrdtValidationResult {
    const issues: RallarCrdtValidationIssue[] = [];
    requireNonEmpty(metadata.coordinateFrameId, `${path}.coordinateFrameId`, issues);
    requireNonEmpty(metadata.coordinateFrameVersion, `${path}.coordinateFrameVersion`, issues);

    if (
        metadata.confidence !== undefined &&
        (!Number.isFinite(metadata.confidence) || metadata.confidence < 0 || metadata.confidence > 1)
    ) {
        issues.push({
            path: `${path}.confidence`,
            code: 'invalid-confidence',
            message: 'Spatial CRDT confidence must be between 0 and 1.'
        });
    }
    if (
        metadata.accuracyMeters !== undefined &&
        (!Number.isFinite(metadata.accuracyMeters) || metadata.accuracyMeters < 0)
    ) {
        issues.push({
            path: `${path}.accuracyMeters`,
            code: 'invalid-accuracy',
            message: 'Spatial CRDT accuracy must be a non-negative number.'
        });
    }

    return {
        valid: issues.length === 0,
        issues
    };
}

export function toRallarCrdtAppendRejectionCategory(
    code: RallarCrdtAppendRejectionCode
): RallarCrdtHardeningErrorCategory {
    switch (code) {
        case 'storage-failed':
        case 'rate-limited':
            return 'retryable.server';
        case 'authorization-denied':
            return 'permanent.authorization';
        case 'quota-exceeded':
        case 'update-too-large':
            return 'permanent.quota';
        case 'invalid-update':
        case 'schema-version-not-allowed':
        case 'duplicate-hash-mismatch':
            return 'permanent.validation';
        case 'document-archived':
        case 'document-destroyed':
        case 'document-quarantined':
        case 'feature-disabled':
            return 'permanent.authorization';
    }
}

export function toRallarCrdtDocumentKeyCursor(documentKey: string): string {
    return `key:${encodeURIComponent(documentKey)}`;
}

export function fromRallarCrdtDocumentKeyCursor(cursor: string | undefined): string | undefined {
    return cursor?.startsWith('key:') ? decodeURIComponent(cursor.slice(4)) : undefined;
}

export interface RallarCrdtTransportMetricTagsInput {
    readonly transport?: RallarCrdtTransportStrategy;
    readonly scope?: RallarCrdtDocumentScope;
    readonly status?: string;
    readonly reason?: string;
}

export function toRallarCrdtTransportMetricTags(
    input: RallarCrdtTransportMetricTagsInput
): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined) as [string, string][]
    );
}

interface DenyInput {
    readonly code: Exclude<RallarCrdtFeatureDecisionCode, 'allowed'>;
    readonly reason: string;
    readonly rollout: RallarCrdtRolloutLabel;
    readonly policy: RallarCrdtDocumentTypePolicy | undefined;
}

function deny(input: DenyInput): RallarCrdtFeatureDecision {
    return {
        allowed: false,
        code: input.code,
        reason: input.reason,
        rollout: input.rollout,
        retryable: false,
        policy: input.policy
    };
}

function destructiveCompactionBlocked(
    code: Exclude<RallarCrdtDestructiveCompactionSafetyCode, 'safe'>,
    reason: string
): RallarCrdtDestructiveCompactionSafety {
    return {
        safe: false,
        code,
        reason,
        compactableUpdateIds: []
    };
}

function createBundleIntegrity<TPayload extends RallarCrdtOperationBatch>(
    bundle:
        | Omit<RallarCrdtDebugBundle<TPayload>, 'integrity'>
        | Omit<RallarCrdtBackupBundle<TPayload>, 'integrity'>
): RallarCrdtBundleIntegrity {
    const sequences = bundle.records.map((record) => record.append.appendSequence);
    const integrityWithoutHash = {
        documentRefHash: hashDocumentRef(bundle.document),
        snapshotHash: bundle.snapshot ? hashJsonSerializable(bundle.snapshot) : undefined,
        updateHashes: Object.fromEntries(
            bundle.records.map((record) => [
                record.update.updateId,
                hashRallarCrdtUpdateEnvelope(record.update)
            ])
        ),
        firstAppendSequence: sequences[0],
        lastAppendSequence: sequences.at(-1),
        updateCount: bundle.records.length,
        sequenceGaps: findAppendSequenceGaps(bundle.records)
    };

    return {
        bundleHash: hashBundleWithIntegrity(bundle, integrityWithoutHash),
        ...integrityWithoutHash
    };
}

function redactDebugRecord<TPayload extends RallarCrdtOperationBatch>(
    record: RallarCrdtDurableUpdateRecord<TPayload>
): RallarCrdtDurableUpdateRecord<TPayload> {
    const redactedPayload: TPayload = {
        ...record.update.payload,
        operations: []
    };
    Reflect.deleteProperty(redactedPayload, 'encryption');
    const { hash: _discardedHash, ...originalUpdateWithoutHash } = record.update;
    const updateWithoutHash = {
        ...originalUpdateWithoutHash,
        payload: redactedPayload
    };
    const redactedHash = hashRallarCrdtUpdateEnvelope(
        updateWithoutHash as RallarCrdtUpdateEnvelope<TPayload>
    );
    const redactedUpdate = {
        ...updateWithoutHash,
        hash: redactedHash
    } as RallarCrdtUpdateEnvelope<TPayload>;

    return {
        ...record,
        update: redactedUpdate,
        append: {
            ...record.append,
            acceptedUpdateHash: redactedHash
        }
    };
}

function hashBundleWithoutHash(
    bundle:
        | RallarCrdtDebugBundle
        | RallarCrdtBackupBundle
        | Omit<RallarCrdtDebugBundle, 'integrity'>
        | Omit<RallarCrdtBackupBundle, 'integrity'>
): string {
    if ('integrity' in bundle) {
        const { bundleHash: _bundleHash, ...integrityWithoutHash } = bundle.integrity;
        return hashBundleWithIntegrity(bundle, integrityWithoutHash);
    }

    return hashJsonSerializable(bundle);
}

function hashBundleWithIntegrity(
    bundle:
        | RallarCrdtDebugBundle
        | RallarCrdtBackupBundle
        | Omit<RallarCrdtDebugBundle, 'integrity'>
        | Omit<RallarCrdtBackupBundle, 'integrity'>,
    integrityWithoutHash: Omit<RallarCrdtBundleIntegrity, 'bundleHash'>
): string {
    return hashJsonSerializable({
        ...bundle,
        integrity: integrityWithoutHash
    });
}

function hashDocumentRef(document: RallarCrdtDocumentRef): string {
    return hashRallarCrdtJson(canonicalRallarCrdtDocumentRef(document));
}

function hashJsonSerializable(value: unknown): string {
    return hashRallarCrdtJson(stripUndefined(value));
}

function stripUndefined(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripUndefined);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([, entryValue]) => entryValue !== undefined)
                .map(([key, entryValue]) => [key, stripUndefined(entryValue)])
        );
    }
    return value;
}

function findAppendSequenceGaps<TPayload extends RallarCrdtOperationBatch>(
    records: readonly RallarCrdtDurableUpdateRecord<TPayload>[]
): readonly number[] {
    const sorted = [...records]
        .map((record) => record.append.appendSequence)
        .sort((left, right) => left - right);
    const gaps: number[] = [];

    for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1] ?? 0;
        const current = sorted[index] ?? previous;
        for (let missing = previous + 1; missing < current; missing += 1) {
            gaps.push(missing);
        }
    }

    return gaps;
}

function requireNonEmpty(
    value: string | undefined,
    path: string,
    issues: RallarCrdtValidationIssue[]
): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
        issues.push({
            path,
            code: 'invalid-non-empty-string',
            message: 'Spatial CRDT metadata field must be a non-empty string.'
        });
    }
}
