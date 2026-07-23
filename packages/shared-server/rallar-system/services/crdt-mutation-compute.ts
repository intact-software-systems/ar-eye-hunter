import {
    byteLengthOfRallarCrdtJson,
    createRallarCrdtDebugBundle,
    createRallarCrdtCompactedSnapshot,
    createRallarCrdtErasureAuditEvent,
    hashRallarCrdtUpdateEnvelope,
    validateRallarCrdtUpdateEnvelope,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtAppendResult,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import { decodeCrdtMutationResult } from './crdt-mutation-codec.ts';
import type {
    CrdtAppendCommand,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationComputedRejected,
    CrdtMutationComputedReplay,
    CrdtMutationComputedWrite,
    CrdtMutationRead,
    CrdtMutationResult,
} from './crdt-mutation-contracts.ts';
import { toAppendOutbox } from './crdt-mutation-outbox.ts';
import {
    appendRejectionReason,
    toAppendRejectionCode,
} from './crdt-append-rejection.ts';

export function computeCrdtMutation(
    command: CrdtMutationCommand,
    read: CrdtMutationRead,
    serviceId: string,
): CrdtMutationComputed {
    if (!read.authorized) return rejected(command, read, 'authorization-denied', serviceId);
    if (!read.featureDecision.allowed) return rejected(command, read, 'feature-disabled', serviceId);
    if (command.operation === 'append') return computeAppend(command, read, serviceId);
    if (!read.document) return rejected(command, read, 'document-not-found', serviceId);
    const next: RallarCrdtDocumentMetadata = {
        ...read.document,
        documentRevision: read.document.documentRevision + 1,
        updatedAtEpochMs: command.capturedAtEpochMs,
        projectionIds: command.operation === 'rebuild-projection'
            ? [...new Set([...read.document.projectionIds, command.projectionId])]
            : command.operation === 'lifecycle'
            ? command.projectionIds
            : read.document.projectionIds,
        lifecycle: command.operation === 'lifecycle'
            ? command.lifecycle
            : command.operation === 'erase' && command.mode === 'destroy-document'
            ? 'destroyed'
            : read.document.lifecycle,
        archivedAtEpochMs: command.operation === 'lifecycle' && command.lifecycle === 'archived'
            ? command.capturedAtEpochMs
            : read.document.archivedAtEpochMs,
        destroyedAtEpochMs: command.operation === 'erase' && command.mode === 'destroy-document'
            ? command.capturedAtEpochMs
            : command.operation === 'lifecycle' && command.lifecycle === 'destroyed'
            ? command.capturedAtEpochMs
            : read.document.destroyedAtEpochMs,
        retention: command.operation === 'lifecycle' ? command.retention : read.document.retention,
        quota: command.operation === 'lifecycle' ? command.quota : read.document.quota,
        snapshotCount: command.operation === 'compact'
            ? read.document.snapshotCount + 1
            : read.document.snapshotCount,
    };
    const snapshot = command.operation === 'compact'
        ? command.snapshot ?? createRallarCrdtCompactedSnapshot({
            document: command.document,
            records: read.records,
            reason: command.reason,
            now: () => command.capturedAtEpochMs,
        })
        : null;
    return writeComputed(
        command,
        read,
        next,
        snapshot,
    );
}

function computeAppend(
    command: CrdtAppendCommand,
    read: CrdtMutationRead,
    serviceId: string,
): CrdtMutationComputed {
    const validation = validateRallarCrdtUpdateEnvelope(command.update);
    if (!validation.valid) return rejected(command, read, 'invalid-update', serviceId);
    const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
    if (read.existingUpdate) {
        const code = hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
            ? null
            : 'duplicate-hash-mismatch';
        return code === null
            ? replay(command, read, serviceId)
            : rejected(command, read, code, serviceId);
    }
    if (read.document && read.document.lifecycle !== 'active') {
        return rejected(command, read, `document-${read.document.lifecycle}`, serviceId);
    }
    const updateBytes = byteLengthOfRallarCrdtJson(command.update);
    const quota = read.document?.quota;
    if (quota?.maxUpdateCount !== undefined && read.document!.updateCount >= quota.maxUpdateCount) {
        return rejected(command, read, 'quota-exceeded', serviceId);
    }
    if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
        return rejected(command, read, 'update-too-large', serviceId);
    }
    if (
        quota?.maxDocumentBytes !== undefined &&
        read.document!.storedUpdateBytes + read.storedSnapshotBytes + updateBytes >
            quota.maxDocumentBytes
    ) {
        return rejected(command, read, 'quota-exceeded', serviceId);
    }
    if (
        quota?.maxUpdatesPerMinutePerActor !== undefined &&
        read.actorUpdatesInWindow >= quota.maxUpdatesPerMinutePerActor
    ) {
        return rejected(command, read, 'rate-limited', serviceId);
    }
    const appendSequence = (read.document?.lastAppendSequence ?? 0) + 1;
    const append = {
        appendSequence,
        acceptedAtEpochMs: command.capturedAtEpochMs,
        actorId: command.actor.actorId,
        principalId: command.actor.principalId,
        sessionId: command.actor.sessionId,
        serverId: command.actor.serverId,
        authorizationScope: command.authorizationScope,
        acceptedUpdateHash: candidateHash,
    } as const;
    const document = nextAppendDocument(command, read.document, appendSequence, updateBytes);
    const appendResult: RallarCrdtAppendResult = {
        status: 'accepted', update: command.update, append, document,
    };
    const response = result(command, 'accepted', document, appendSequence, null, {
        appendResult,
    });
    return {
        outcome: 'write',
        operation: command.operation,
        commandId: command.commandId,
        commandHash: command.commandHash,
        documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
        expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
        document,
        update: command.update,
        append,
        snapshot: null,
        outboxEntries: toAppendOutbox(command, appendResult, serviceId, true),
        result: response,
    };
}

function nextAppendDocument(
    command: CrdtAppendCommand,
    current: RallarCrdtDocumentMetadata | null,
    appendSequence: number,
    updateBytes: number,
): RallarCrdtDocumentMetadata {
    if (current) {
        return {
            ...current,
            documentRevision: current.documentRevision + 1,
            updatedAtEpochMs: command.capturedAtEpochMs,
            lastAppendSequence: appendSequence,
            updateCount: current.updateCount + 1,
            storedUpdateBytes: current.storedUpdateBytes + updateBytes,
        };
    }
    return {
        document: command.document,
        documentKey: command.documentKey,
        documentRevision: 1,
        lifecycle: 'active',
        createdAtEpochMs: command.capturedAtEpochMs,
        updatedAtEpochMs: command.capturedAtEpochMs,
        archivedAtEpochMs: null,
        destroyedAtEpochMs: null,
        lastAppendSequence: 1,
        updateCount: 1,
        snapshotCount: 0,
        storedUpdateBytes: updateBytes,
        retention: null,
        quota: null,
        projectionIds: [],
    };
}

function writeComputed(
    command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
    read: CrdtMutationRead,
    document: RallarCrdtDocumentMetadata,
    snapshot: RallarCrdtSnapshotEnvelope | null,
): CrdtMutationComputedWrite {
    const resultDetails = adminResultDetails(command, read, document, snapshot);
    return {
        outcome: 'write', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: read.document!.documentRevision,
        expectedDocumentLifecycle: read.document!.lifecycle,
        expectedAppendSequence: read.document!.lastAppendSequence,
        document, update: null, append: null,
        snapshot, outboxEntries: [],
        result: result(
            command,
            'accepted',
            document,
            document.lastAppendSequence,
            null,
            resultDetails,
        ),
    };
}

function replay(
    command: CrdtAppendCommand,
    read: CrdtMutationRead,
    serviceId: string,
): CrdtMutationComputedReplay {
    const append = read.existingAppend ?? fallbackReplayAppend(command, read.document);
    const appendResult: RallarCrdtAppendResult = read.document
        ? { status: 'duplicate', update: command.update, append, document: read.document }
        : rejectionResult(command, null, 'storage-failed');
    const response = result(
        command,
        'replay',
        read.document,
        append.appendSequence,
        null,
        { appendResult },
    );
    return {
        outcome: 'replay', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
        expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
        document: read.document,
        update: command.update, append, snapshot: null,
        outboxEntries: toAppendOutbox(command, appendResult, serviceId, false), result: response,
    };
}

function rejected(
    command: CrdtMutationCommand,
    read: CrdtMutationRead,
    code: string,
    serviceId: string,
): CrdtMutationComputedRejected {
    const appendResult = command.operation === 'append'
        ? rejectionResult(command, read.document, code)
        : undefined;
    const response = result(
        command,
        'rejected',
        read.document,
        null,
        code,
        appendResult
            ? { appendResult }
            : rejectedAdminDetails(command as Exclude<CrdtMutationCommand, CrdtAppendCommand>),
    );
    return {
        outcome: 'rejected', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
        expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
        document: read.document,
        update: command.operation === 'append' ? command.update : null,
        append: null, snapshot: null, code,
        outboxEntries: command.operation === 'append'
            ? toAppendOutbox(command, appendResult!, serviceId, false)
            : [],
        result: response,
    };
}

function result(
    command: CrdtMutationCommand,
    status: CrdtMutationResult['status'],
    document: RallarCrdtDocumentMetadata | null,
    appendSequence: number | null,
    code: string | null,
    details: Record<string, unknown>,
): CrdtMutationResult {
    return {
        version: 1, operation: command.operation, status, commandId: command.commandId,
        documentKey: command.documentKey,
        documentRevision: document?.documentRevision ?? null,
        appendSequence, code, ...details,
    } as CrdtMutationResult;
}

function adminResultDetails(
    command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
    read: CrdtMutationRead,
    document: RallarCrdtDocumentMetadata,
    snapshot: RallarCrdtSnapshotEnvelope | null,
): Record<string, unknown> {
    if (command.operation === 'compact') return { snapshot };
    if (command.operation === 'lifecycle') return { metadata: document };
    const bundle = createRallarCrdtDebugBundle({
        exportedAtEpochMs: command.capturedAtEpochMs,
        reason: command.operation === 'erase' ? command.reason : `rebuild:${command.projectionId}`,
        document: command.document,
        metadata: document,
        ...(read.snapshot ? { snapshot: read.snapshot } : {}),
        records: read.records,
        ...(command.operation === 'erase' && command.mode === 'redact-payloads'
            ? { redaction: { payloadsRedacted: true, reason: command.reason } }
            : {}),
    });
    if (command.operation === 'rebuild-projection') {
        return { integrity: verifyRallarCrdtDebugBundle(bundle) };
    }
    const request = {
        document: command.document,
        requestedAtEpochMs: command.capturedAtEpochMs,
        requestedBy: command.actor.principalId,
        reason: command.reason,
        mode: command.mode,
    } as const;
    return {
        request,
        auditEvent: createRallarCrdtErasureAuditEvent(request),
        metadata: document,
        redactedBundle: command.mode === 'redact-payloads' ? bundle : null,
    };
}

function rejectedAdminDetails(
    command: Exclude<CrdtMutationCommand, CrdtAppendCommand>,
): Record<string, unknown> {
    if (command.operation === 'compact') return { snapshot: null };
    if (command.operation === 'lifecycle') return { metadata: null };
    if (command.operation === 'rebuild-projection') return { integrity: null };
    return { request: null, auditEvent: null, metadata: null, redactedBundle: null };
}

function fallbackReplayAppend(
    command: CrdtAppendCommand,
    document: RallarCrdtDocumentMetadata | null,
) {
    return {
        appendSequence: document?.lastAppendSequence ?? 0,
        acceptedAtEpochMs: command.capturedAtEpochMs,
        actorId: command.actor.actorId,
        principalId: command.actor.principalId,
        sessionId: command.actor.sessionId,
        serverId: command.actor.serverId,
        authorizationScope: command.authorizationScope,
        acceptedUpdateHash: hashRallarCrdtUpdateEnvelope(command.update),
    } as const;
}

function rejectionResult(
    command: CrdtAppendCommand,
    document: RallarCrdtDocumentMetadata | null,
    code: string,
): RallarCrdtAppendResult {
    const rejectionCode = toAppendRejectionCode(code);
    return {
        status: 'rejected',
        update: command.update,
        code: rejectionCode,
        reason: appendRejectionReason(rejectionCode),
        retryable: rejectionCode === 'storage-failed' || rejectionCode === 'rate-limited',
        ...(document ? { document } : {}),
    };
}

export function validateCrdtMutation(
    command: CrdtMutationCommand,
    read: CrdtMutationRead,
    computed: CrdtMutationComputed,
): void {
    if (
        computed.commandId !== command.commandId ||
        computed.commandHash !== command.commandHash ||
        computed.documentKey !== command.documentKey
    ) throw new TypeError('CRDT computed identity differs from command');
    if (
        computed.outcome === 'write' &&
        read.document &&
        computed.expectedDocumentRevision !== read.document.documentRevision
    ) throw new TypeError('CRDT computed predecessor differs from read document');
    decodeCrdtMutationResult(computed.result);
}
