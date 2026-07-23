import {
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtQuotaPolicy,
    type RallarCrdtRetentionPolicy,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtTrustedAppendMetadata,
    toRallarCrdtDocumentKey,
    validateRallarCrdtDocumentRef,
    validateRallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireExactOptionalKeys,
    requireNullableEpoch,
    requireOneOf,
    requirePositiveInteger,
    requireRecord,
    requireString,
} from './exact-object-codec.ts';
import { decodeExactEncryptedEnvelopeShape } from './crdt-operation-exact-codec.ts';
import {
    decodeExactCrdtStateSnapshot,
    decodeExactSequenceState,
    decodeExactSnapshotClock,
} from './crdt-snapshot-state-exact-codec.ts';

export function decodeExactSnapshotEnvelope(value: unknown): RallarCrdtSnapshotEnvelope {
    const snapshot = requireRecord(value, 'CRDT snapshot envelope');
    requireExactOptionalKeys(snapshot, [
        'protocolVersion',
        'document',
        'snapshotId',
        'schemaVersion',
        'createdAtEpochMs',
        'maxLamport',
        'includedUpdateIds',
        'value',
        'metadata',
    ], ['updateClock', 'hash'], 'CRDT snapshot envelope');
    decodeExactDocumentRef(snapshot.document, 'CRDT snapshot document');
    if ('updateClock' in snapshot) decodeExactSnapshotClock(snapshot.updateClock);
    if (
        snapshot.value && typeof snapshot.value === 'object' &&
        !Array.isArray(snapshot.value) && (snapshot.value as Record<string, unknown>).kind === 'encrypted-json'
    ) decodeExactEncryptedEnvelopeShape(snapshot.value);
    requireString(snapshot.snapshotId, 'snapshotId');
    requirePositiveInteger(snapshot.schemaVersion, 'snapshot schemaVersion');
    requireEpoch(snapshot.createdAtEpochMs, 'snapshot createdAtEpochMs');
    requireEpoch(snapshot.maxLamport, 'snapshot maxLamport');
    if (
        !Array.isArray(snapshot.includedUpdateIds) ||
        snapshot.includedUpdateIds.some((id) => typeof id !== 'string' || id.length === 0) ||
        new Set(snapshot.includedUpdateIds).size !== snapshot.includedUpdateIds.length
    ) throw new TypeError('CRDT snapshot included update IDs are invalid');
    const metadata = requireRecord(snapshot.metadata, 'CRDT snapshot metadata');
    requireExactOptionalKeys(metadata, ['updateCount'], [
        'createdByReplicaId',
        'tombstoneCount',
        'conflictCount',
        'reason',
        'crdtState',
        'sequenceState',
        'unsafeLegacyCollectionCompaction',
    ], 'CRDT snapshot metadata');
    for (const field of ['updateCount', 'tombstoneCount', 'conflictCount']) {
        if (field in metadata) requireEpoch(metadata[field], `snapshot metadata ${field}`);
    }
    if ('createdByReplicaId' in metadata) {
        requireString(metadata.createdByReplicaId, 'snapshot metadata createdByReplicaId');
    }
    if ('reason' in metadata) requireString(metadata.reason, 'snapshot metadata reason');
    if ('crdtState' in metadata) decodeExactCrdtStateSnapshot(metadata.crdtState);
    if ('sequenceState' in metadata) decodeExactSequenceState(metadata.sequenceState);
    if (
        'unsafeLegacyCollectionCompaction' in metadata &&
        typeof metadata.unsafeLegacyCollectionCompaction !== 'boolean'
    ) throw new TypeError('CRDT snapshot legacy compaction flag is invalid');
    if ('hash' in snapshot) requireString(snapshot.hash, 'snapshot hash');
    if (!validateRallarCrdtSnapshotEnvelope(snapshot).valid) {
        throw new TypeError('CRDT snapshot envelope is invalid');
    }
    return snapshot as unknown as RallarCrdtSnapshotEnvelope;
}

export function decodeExactDocumentRef(
    value: unknown,
    label = 'CRDT document',
): RallarCrdtDocumentRef {
    const document = requireRecord(value, label);
    const keys = [
        'applicationId',
        'scope',
        'documentType',
        'documentId',
        ...('workspaceId' in document ? ['workspaceId'] : []),
        ...('roomRef' in document ? ['roomRef'] : []),
        ...('principalId' in document ? ['principalId'] : []),
        ...('customScope' in document ? ['customScope'] : []),
    ];
    requireExactKeys(document, keys, label);
    if ('roomRef' in document) {
        const roomRef = requireRecord(document.roomRef, `${label} roomRef`);
        requireExactKeys(roomRef, ['applicationId', 'workspaceId', 'groupId'], `${label} roomRef`);
    }
    if (!validateRallarCrdtDocumentRef(document).valid) {
        throw new TypeError(`${label} is invalid`);
    }
    return document as unknown as RallarCrdtDocumentRef;
}

export function decodeExactRetentionPolicy(value: unknown): RallarCrdtRetentionPolicy {
    const policy = requireRecord(value, 'CRDT retention policy');
    requireExactOptionalKeys(
        policy,
        ['mode'],
        ['ttlMs', 'sensitivePayloads', 'reason'],
        'CRDT retention policy',
    );
    const mode = requireOneOf(
        policy.mode,
        ['retain', 'redact-after', 'delete-after'] as const,
        'retention mode',
    );
    if ('ttlMs' in policy) requirePositiveInteger(policy.ttlMs, 'retention ttlMs');
    if (mode !== 'retain' && !('ttlMs' in policy)) {
        throw new TypeError('CRDT retention ttlMs is required for expiring retention');
    }
    if ('sensitivePayloads' in policy && typeof policy.sensitivePayloads !== 'boolean') {
        throw new TypeError('CRDT retention sensitivePayloads is invalid');
    }
    if ('reason' in policy) requireString(policy.reason, 'retention reason');
    return policy as unknown as RallarCrdtRetentionPolicy;
}

export function decodeExactQuotaPolicy(value: unknown): RallarCrdtQuotaPolicy {
    const policy = requireRecord(value, 'CRDT quota policy');
    const keys = [
        'maxUpdateBytes',
        'maxDocumentBytes',
        'maxUpdateCount',
        'maxPendingUpdatesPerReplica',
        'maxUpdatesPerMinutePerActor',
    ];
    requireExactOptionalKeys(policy, [], keys, 'CRDT quota policy');
    if (Object.keys(policy).length === 0) throw new TypeError('CRDT quota policy must set a limit');
    for (const key of keys) {
        if (key in policy) requirePositiveInteger(policy[key], `quota ${key}`);
    }
    return policy as unknown as RallarCrdtQuotaPolicy;
}

export function decodeExactProjectionIds(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new TypeError('CRDT projection IDs are invalid');
    }
    if (new Set(value).size !== value.length) {
        throw new TypeError('CRDT projection IDs must be unique');
    }
    return value as readonly string[];
}

export function decodeExactTrustedAppendMetadata(
    value: unknown,
): RallarCrdtTrustedAppendMetadata {
    const append = requireRecord(value, 'CRDT append metadata');
    requireExactKeys(append, [
        'appendSequence',
        'acceptedAtEpochMs',
        'actorId',
        'principalId',
        'sessionId',
        'serverId',
        'authorizationScope',
        'acceptedUpdateHash',
    ], 'CRDT append metadata');
    requirePositiveInteger(append.appendSequence, 'append sequence');
    requireEpoch(append.acceptedAtEpochMs, 'append acceptedAtEpochMs');
    for (const field of ['actorId', 'principalId', 'sessionId', 'serverId', 'acceptedUpdateHash']) {
        requireString(append[field], `append ${field}`);
    }
    requireOneOf(
        append.authorizationScope,
        ['room', 'principal', 'app', 'custom'] as const,
        'append authorizationScope',
    );
    return append as unknown as RallarCrdtTrustedAppendMetadata;
}

export function decodeExactDocumentMetadata(value: unknown): RallarCrdtDocumentMetadata {
    const metadata = requireRecord(value, 'CRDT document metadata');
    requireExactKeys(metadata, [
        'document',
        'documentKey',
        'documentRevision',
        'lifecycle',
        'createdAtEpochMs',
        'updatedAtEpochMs',
        'archivedAtEpochMs',
        'destroyedAtEpochMs',
        'lastAppendSequence',
        'updateCount',
        'snapshotCount',
        'storedUpdateBytes',
        'retention',
        'quota',
        'projectionIds',
    ], 'CRDT document metadata');
    const document = decodeExactDocumentRef(metadata.document, 'CRDT metadata document');
    requireString(metadata.documentKey, 'metadata documentKey');
    if (toRallarCrdtDocumentKey(document) !== metadata.documentKey) {
        throw new TypeError('CRDT metadata document key differs from document');
    }
    requirePositiveInteger(metadata.documentRevision, 'metadata documentRevision');
    const lifecycle = requireOneOf(
        metadata.lifecycle,
        ['active', 'archived', 'destroyed', 'quarantined'] as const,
        'metadata lifecycle',
    );
    requireEpoch(metadata.createdAtEpochMs, 'metadata createdAtEpochMs');
    requireEpoch(metadata.updatedAtEpochMs, 'metadata updatedAtEpochMs');
    if ((metadata.updatedAtEpochMs as number) < (metadata.createdAtEpochMs as number)) {
        throw new TypeError('CRDT metadata update time precedes creation');
    }
    requireNullableEpoch(metadata.archivedAtEpochMs, 'metadata archivedAtEpochMs');
    requireNullableEpoch(metadata.destroyedAtEpochMs, 'metadata destroyedAtEpochMs');
    if (lifecycle === 'archived' && metadata.archivedAtEpochMs === null) {
        throw new TypeError('CRDT metadata archived lifecycle lacks timestamp');
    }
    if (lifecycle === 'destroyed' && metadata.destroyedAtEpochMs === null) {
        throw new TypeError('CRDT metadata destroyed lifecycle lacks timestamp');
    }
    for (const field of ['lastAppendSequence', 'updateCount', 'snapshotCount', 'storedUpdateBytes']) {
        requireEpoch(metadata[field], `metadata ${field}`);
    }
    if ((metadata.lastAppendSequence as number) < (metadata.updateCount as number)) {
        throw new TypeError('CRDT metadata update counters are inconsistent');
    }
    if (metadata.retention !== null) decodeExactRetentionPolicy(metadata.retention);
    if (metadata.quota !== null) decodeExactQuotaPolicy(metadata.quota);
    decodeExactProjectionIds(metadata.projectionIds);
    return metadata as unknown as RallarCrdtDocumentMetadata;
}

export function decodeExactValidationResult(value: unknown): Record<string, unknown> {
    const validation = requireRecord(value, 'CRDT validation result');
    requireExactKeys(validation, ['valid', 'issues'], 'CRDT validation result');
    if (typeof validation.valid !== 'boolean' || !Array.isArray(validation.issues)) {
        throw new TypeError('CRDT validation result is invalid');
    }
    for (const issue of validation.issues) {
        const fields = requireRecord(issue, 'CRDT validation issue');
        requireExactKeys(fields, ['path', 'code', 'message'], 'CRDT validation issue');
        for (const field of ['path', 'code', 'message']) {
            requireString(fields[field], `validation issue ${field}`);
        }
    }
    if (validation.valid !== (validation.issues.length === 0)) {
        throw new TypeError('CRDT validation result differs from issues');
    }
    return validation;
}

export function decodeExactIntegrityReport(value: unknown): Record<string, unknown> {
    const report = requireRecord(value, 'CRDT integrity report');
    requireExactOptionalKeys(report, [
        'valid',
        'issues',
        'documentKey',
        'checkedUpdateCount',
        'sequenceGaps',
    ], ['bundleHash'], 'CRDT integrity report');
    if (typeof report.valid !== 'boolean' || !Array.isArray(report.issues)) {
        throw new TypeError('CRDT integrity report validity is invalid');
    }
    for (const issue of report.issues) {
        const fields = requireRecord(issue, 'CRDT integrity issue');
        requireExactKeys(fields, ['path', 'code', 'message'], 'CRDT integrity issue');
        for (const field of ['path', 'code', 'message']) requireString(fields[field], `issue ${field}`);
    }
    if (report.valid !== (report.issues.length === 0)) {
        throw new TypeError('CRDT integrity report validity differs from issues');
    }
    requireString(report.documentKey, 'integrity documentKey');
    requireEpoch(report.checkedUpdateCount, 'integrity checkedUpdateCount');
    if (
        !Array.isArray(report.sequenceGaps) ||
        report.sequenceGaps.some((gap) => !Number.isSafeInteger(gap) || gap < 1) ||
        new Set(report.sequenceGaps).size !== report.sequenceGaps.length
    ) throw new TypeError('CRDT integrity sequence gaps are invalid');
    if ('bundleHash' in report) requireString(report.bundleHash, 'integrity bundleHash');
    return report;
}

export function decodeExactErasureRequest(value: unknown): Record<string, unknown> {
    const request = requireRecord(value, 'CRDT erasure request');
    requireExactKeys(request, [
        'document',
        'requestedAtEpochMs',
        'requestedBy',
        'reason',
        'mode',
    ], 'CRDT erasure request');
    decodeExactDocumentRef(request.document, 'CRDT erasure document');
    requireEpoch(request.requestedAtEpochMs, 'erasure requestedAtEpochMs');
    requireString(request.requestedBy, 'erasure requestedBy');
    requireString(request.reason, 'erasure reason');
    requireOneOf(request.mode, ['destroy-document', 'redact-payloads'] as const, 'erasure mode');
    return request;
}

export function decodeExactErasureAuditEvent(value: unknown): Record<string, unknown> {
    const event = requireRecord(value, 'CRDT erasure audit event');
    requireExactKeys(event, [
        'kind',
        'atEpochMs',
        'documentKey',
        'principalId',
        'reason',
        'metadata',
    ], 'CRDT erasure audit event');
    requireOneOf(event.kind, ['erase', 'redact'] as const, 'erasure audit kind');
    requireEpoch(event.atEpochMs, 'erasure audit atEpochMs');
    for (const field of ['documentKey', 'principalId', 'reason']) {
        requireString(event[field], `erasure audit ${field}`);
    }
    const metadata = requireRecord(event.metadata, 'CRDT erasure audit metadata');
    requireExactKeys(metadata, ['mode'], 'CRDT erasure audit metadata');
    requireOneOf(metadata.mode, ['destroy-document', 'redact-payloads'] as const, 'audit mode');
    return event;
}
