import {
    byteLengthOfRallarCrdtJson,
    createRallarCrdtCompactedSnapshot,
    hashRallarCrdtUpdateEnvelope,
    validateRallarCrdtUpdateEnvelope,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtSnapshotEnvelope,
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
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
import { toAppendOutbox, toAuditOutbox } from './crdt-mutation-outbox.ts';

export function computeCrdtMutation(
    command: CrdtMutationCommand,
    read: CrdtMutationRead,
    serviceId: string,
): CrdtMutationComputed {
    if (!read.authorized) return rejected(command, read.document, 'authorization-denied', serviceId);
    if (command.operation === 'append') return computeAppend(command, read, serviceId);
    if (!read.document) return rejected(command, null, 'document-not-found', serviceId);
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
    const outboxEntries = command.operation === 'erase'
        ? [toAuditOutbox(command, serviceId)]
        : [];
    return writeComputed(
        command,
        read.document.documentRevision,
        next,
        snapshot,
        outboxEntries,
    );
}

function computeAppend(
    command: CrdtAppendCommand,
    read: CrdtMutationRead,
    serviceId: string,
): CrdtMutationComputed {
    const validation = validateRallarCrdtUpdateEnvelope(command.update);
    if (!validation.valid) return rejected(command, read.document, 'invalid-update', serviceId);
    const candidateHash = hashRallarCrdtUpdateEnvelope(command.update);
    if (read.existingUpdate) {
        const code = hashRallarCrdtUpdateEnvelope(read.existingUpdate) === candidateHash
            ? null
            : 'duplicate-hash-mismatch';
        return code === null
            ? replay(command, read.document, serviceId)
            : rejected(command, read.document, code, serviceId);
    }
    if (read.document && read.document.lifecycle !== 'active') {
        return rejected(command, read.document, `document-${read.document.lifecycle}`, serviceId);
    }
    const updateBytes = byteLengthOfRallarCrdtJson(command.update);
    const quota = read.document?.quota;
    if (quota?.maxUpdateCount !== undefined && read.document!.updateCount >= quota.maxUpdateCount) {
        return rejected(command, read.document, 'quota-exceeded', serviceId);
    }
    if (quota?.maxUpdateBytes !== undefined && updateBytes > quota.maxUpdateBytes) {
        return rejected(command, read.document, 'update-too-large', serviceId);
    }
    if (quota?.maxDocumentBytes !== undefined && read.document!.storedUpdateBytes + updateBytes > quota.maxDocumentBytes) {
        return rejected(command, read.document, 'quota-exceeded', serviceId);
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
    const response = result(command, 'accepted', document, appendSequence, null);
    return {
        outcome: 'write',
        operation: command.operation,
        commandId: command.commandId,
        commandHash: command.commandHash,
        documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        document,
        update: command.update,
        append,
        snapshot: null,
        outboxEntries: toAppendOutbox(command, response, serviceId),
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
    expectedRevision: number,
    document: RallarCrdtDocumentMetadata,
    snapshot: RallarCrdtSnapshotEnvelope | null,
    outboxEntries: readonly ResourceEntry[],
): CrdtMutationComputedWrite {
    return {
        outcome: 'write', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: expectedRevision, document, update: null, append: null,
        snapshot, outboxEntries,
        result: result(command, 'accepted', document, null, null),
    };
}

function replay(
    command: CrdtAppendCommand,
    document: RallarCrdtDocumentMetadata | null,
    serviceId: string,
): CrdtMutationComputedReplay {
    const response = result(command, 'replay', document, document?.lastAppendSequence ?? null, null);
    return {
        outcome: 'replay', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: document?.documentRevision ?? 'absent', document,
        update: command.update, append: null, snapshot: null,
        outboxEntries: toAppendOutbox(command, response, serviceId), result: response,
    };
}

function rejected(
    command: CrdtMutationCommand,
    document: RallarCrdtDocumentMetadata | null,
    code: string,
    serviceId: string,
): CrdtMutationComputedRejected {
    const response = result(command, 'rejected', document, null, code);
    return {
        outcome: 'rejected', operation: command.operation, commandId: command.commandId,
        commandHash: command.commandHash, documentKey: command.documentKey,
        expectedDocumentRevision: document?.documentRevision ?? 'absent', document,
        update: command.operation === 'append' ? command.update : null,
        append: null, snapshot: null, code,
        outboxEntries: command.operation === 'append'
            ? toAppendOutbox(command, response, serviceId)
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
): CrdtMutationResult {
    return {
        version: 1, operation: command.operation, status, commandId: command.commandId,
        documentKey: command.documentKey,
        documentRevision: document?.documentRevision ?? null,
        appendSequence, code,
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
