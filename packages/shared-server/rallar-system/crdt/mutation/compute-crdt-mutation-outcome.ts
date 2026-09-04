import type {
    RallarCrdtAppendRejected,
    RallarCrdtAppendResult,
    RallarCrdtDocumentMetadata,
    RallarCrdtTrustedAppendMetadata
} from '@shared/crdt/mod.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { computeAppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import { appendRejectionReason, isAppendRejectionRetryable, toAppendRejectionCode } from './crdt-append-rejection.ts';
import type {
    CrdtAppendCommand,
    CrdtCanonicalSnapshotEnvelope,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationComputedRejected,
    CrdtMutationComputedReplay,
    CrdtMutationComputedWrite,
    CrdtMutationRead,
    CrdtSnapshotWrite,
    CrdtUpdateWrite
} from './crdt-mutation-contracts.ts';
import {
    createAcceptedCrdtAdministrationMutationResult,
    createRejectedCrdtAdministrationMutationResult
} from './create-crdt-administration-mutation-result.ts';
import {
    createAcceptedCrdtAppendMutationResult,
    createRejectedCrdtAppendMutationResult,
    createReplayCrdtAppendMutationResult
} from './create-crdt-append-mutation-result.ts';
import { toAppendOutbox, toCrdtAuditOutbox } from './create-crdt-mutation-outbox.ts';

export interface ComputeCrdtAcceptedAppendOutcomeInput {
    readonly command: CrdtAppendCommand;
    readonly read: CrdtMutationRead;
    readonly document: RallarCrdtDocumentMetadata;
    readonly append: RallarCrdtTrustedAppendMetadata;
    readonly serviceId: string;
}
export interface ComputeCrdtReplayOutcomeInput {
    readonly command: CrdtAppendCommand;
    readonly read: CrdtMutationRead;
    readonly serviceId: string;
}

export interface ComputeCrdtRejectedOutcomeInput {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly code: string;
    readonly serviceId: string;
}

export interface ComputeCrdtAcceptedAdministrationOutcomeInput {
    readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
    readonly read: CrdtMutationRead;
    readonly document: RallarCrdtDocumentMetadata;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
    readonly serviceId: string;
}

interface CreateCrdtMutationComputedBaseInput<TDocument extends RallarCrdtDocumentMetadata | null> {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly document: TDocument;
    readonly update: CrdtAppendCommand['update'] | null;
    readonly append: CrdtMutationComputed['append'];
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
    readonly outboxEntries: readonly ResourceEntry[];
    readonly result: CrdtMutationComputed['result'];
}

interface CrdtMutationComputedBaseValues<TDocument extends RallarCrdtDocumentMetadata | null> {
    readonly command: CrdtMutationCommand;
    readonly read: CrdtMutationRead;
    readonly operation: CrdtMutationCommand['operation'];
    readonly commandId: string;
    readonly commandHash: string;
    readonly documentKey: string;
    readonly expectedDocumentRevision: number | 'absent';
    readonly expectedDocumentLifecycle: CrdtMutationComputed['expectedDocumentLifecycle'];
    readonly expectedAppendSequence: number | 'absent';
    readonly document: TDocument;
    readonly update: CrdtAppendCommand['update'] | null;
    readonly append: CrdtMutationComputed['append'];
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
    readonly outboxWrites: CrdtMutationComputed['outboxWrites'];
    readonly result: CrdtMutationComputed['result'];
}

export function computeCrdtAcceptedAppendOutcome(
    input: ComputeCrdtAcceptedAppendOutcomeInput
): CrdtMutationComputedWrite {
    const { command, read, document, append, serviceId } = input;
    const appendResult: RallarCrdtAppendResult = {
        status: 'accepted',
        update: command.update,
        append,
        document
    };
    const result = createAcceptedCrdtAppendMutationResult({
        command,
        document,
        append,
        appendResult
    });
    return {
        ...createCrdtMutationComputedBase({
            command,
            read,
            document,
            update: command.update,
            append,
            snapshot: null,
            outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: true }),
            result
        }),
        outcome: 'write',
        ...computeCrdtMutationWrites({
            read,
            document,
            update: command.update,
            append,
            snapshot: null
        })
    };
}

export function computeCrdtReplayOutcome(
    input: ComputeCrdtReplayOutcomeInput
): CrdtMutationComputedReplay {
    const { command, read, serviceId } = input;
    if (!read.document || !read.existingAppend) {
        throw new TypeError('Persisted CRDT replay requires document and append metadata');
    }
    const append = read.existingAppend;
    const appendResult = {
        status: 'duplicate' as const,
        update: command.update,
        append,
        document: read.document
    };
    const result = createReplayCrdtAppendMutationResult({
        command,
        document: read.document,
        append,
        appendResult
    });
    return {
        ...createCrdtMutationComputedBase({
            command,
            read,
            document: read.document,
            update: command.update,
            append,
            snapshot: null,
            outboxEntries: toAppendOutbox({ command, response: appendResult, serviceId, fanout: false }),
            result
        }),
        outcome: 'replay'
    };
}

export function computeCrdtRejectedOutcome(
    input: ComputeCrdtRejectedOutcomeInput
): CrdtMutationComputedRejected {
    const { command, read, code, serviceId } = input;
    const result = command.operation === 'append'
        ? createRejectedCrdtAppendMutationResult({
            command,
            document: read.document,
            code,
            appendResult: toCrdtAppendRejection(command, read.document, code)
        })
        : createRejectedCrdtAdministrationMutationResult({
            command,
            document: read.document,
            code
        });
    const outboxEntries = command.operation === 'append' &&
            result.operation === 'append' &&
            read.authorized &&
            !code.startsWith('authorization-') &&
            !code.startsWith('authentication-')
        ? toAppendOutbox({ command, response: result.appendResult, serviceId, fanout: false })
        : [];
    return {
        ...createCrdtMutationComputedBase({
            command,
            read,
            document: read.document,
            update: command.operation === 'append' ? command.update : null,
            append: null,
            snapshot: null,
            outboxEntries,
            result
        }),
        outcome: 'rejected',
        code
    };
}

export function computeCrdtAcceptedAdministrationOutcome(
    input: ComputeCrdtAcceptedAdministrationOutcomeInput
): CrdtMutationComputedWrite {
    const { command, read, document, snapshot, serviceId } = input;
    const result = createAcceptedCrdtAdministrationMutationResult({
        command,
        read,
        document,
        snapshot
    });
    const auditEvent = result.operation === 'erase' && result.status === 'accepted' ? result.auditEvent : null;
    return {
        ...createCrdtMutationComputedBase({
            command,
            read,
            document,
            update: null,
            append: null,
            snapshot,
            outboxEntries: auditEvent ? [toCrdtAuditOutbox(auditEvent, command, serviceId)] : [],
            result
        }),
        outcome: 'write',
        ...computeCrdtMutationWrites({
            read,
            document,
            update: null,
            append: null,
            snapshot
        })
    };
}

function createCrdtMutationComputedBase<TDocument extends RallarCrdtDocumentMetadata | null>(
    input: CreateCrdtMutationComputedBaseInput<TDocument>
): CrdtMutationComputedBaseValues<TDocument> {
    const { command, read, document, update, append, snapshot, outboxEntries, result } = input;
    return {
        command,
        read,
        operation: command.operation,
        commandId: command.commandId,
        commandHash: command.commandHash,
        documentKey: command.documentKey,
        expectedDocumentRevision: read.document?.documentRevision ?? 'absent',
        expectedDocumentLifecycle: read.document?.lifecycle ?? 'absent',
        expectedAppendSequence: read.document?.lastAppendSequence ?? 'absent',
        document,
        update,
        append,
        snapshot,
        outboxWrites: outboxEntries.map(computeAppOutboxInsert),
        result
    };
}

export interface ComputeCrdtMutationWritesInput {
    readonly read: CrdtMutationRead;
    readonly document: RallarCrdtDocumentMetadata;
    readonly update: CrdtAppendCommand['update'] | null;
    readonly append: RallarCrdtTrustedAppendMetadata | null;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
}

export function computeCrdtMutationWrites(
    input: ComputeCrdtMutationWritesInput
): Pick<CrdtMutationComputedWrite, 'documentWrite' | 'updateWrite' | 'snapshotWrite'> {
    const { read, document, update, append, snapshot } = input;
    const values = {
        documentKey: document.documentKey,
        applicationId: document.document.applicationId,
        workspaceId: document.document.workspaceId,
        scope: document.document.scope,
        documentType: document.document.documentType,
        documentId: document.document.documentId,
        documentRefJson: JSON.stringify(document.document),
        documentRevision: document.documentRevision,
        lifecycle: document.lifecycle,
        createdAt: new Date(document.createdAtEpochMs),
        updatedAt: new Date(document.updatedAtEpochMs),
        archivedAt: toOptionalCrdtDate(document.archivedAtEpochMs),
        destroyedAt: toOptionalCrdtDate(document.destroyedAtEpochMs),
        lastAppendSequence: document.lastAppendSequence,
        updateCount: document.updateCount,
        snapshotCount: document.snapshotCount,
        storedUpdateBytes: document.storedUpdateBytes,
        retentionJson: toOptionalCrdtJson(document.retention),
        quotaJson: toOptionalCrdtJson(document.quota),
        projectionIdsJson: JSON.stringify(document.projectionIds)
    };
    const documentWrite = read.document === null
        ? { ...values, operation: 'insert' as const }
        : {
            ...values,
            operation: 'update' as const,
            expectedRevision: read.document.documentRevision,
            expectedLifecycle: read.document.lifecycle,
            expectedAppendSequence: read.document.lastAppendSequence
        };
    return {
        documentWrite,
        updateWrite: update && append
            ? computeCrdtUpdateWrite(document.documentKey, update, append)
            : null,
        snapshotWrite: snapshot
            ? computeCrdtSnapshotWrite(document.documentKey, document.lastAppendSequence, snapshot)
            : null
    };
}

function computeCrdtUpdateWrite(
    documentKey: string,
    update: CrdtAppendCommand['update'],
    append: RallarCrdtTrustedAppendMetadata
): CrdtUpdateWrite {
    return {
        documentKey,
        appendSequence: append.appendSequence,
        updateId: update.updateId,
        updateEnvelopeJson: JSON.stringify(update),
        acceptedUpdateHash: append.acceptedUpdateHash,
        actorId: append.actorId,
        principalId: append.principalId,
        sessionId: append.sessionId,
        serverId: append.serverId,
        authorizationScope: append.authorizationScope,
        acceptedAt: new Date(append.acceptedAtEpochMs)
    };
}

function computeCrdtSnapshotWrite(
    documentKey: string,
    appendSequence: number,
    snapshot: CrdtCanonicalSnapshotEnvelope
): CrdtSnapshotWrite {
    return {
        documentKey,
        snapshotId: snapshot.snapshotId,
        appendSequence,
        snapshotEnvelopeJson: JSON.stringify(snapshot),
        createdAt: new Date(snapshot.createdAtEpochMs),
        reason: snapshot.metadata.reason
    };
}

function toOptionalCrdtDate(epochMs: number | null): Date | null {
    return epochMs === null ? null : new Date(epochMs);
}

function toOptionalCrdtJson(value: object | null): string | null {
    return value === null ? null : JSON.stringify(value);
}

function toCrdtAppendRejection(
    command: CrdtAppendCommand,
    document: RallarCrdtDocumentMetadata | null,
    code: string
): RallarCrdtAppendRejected {
    const rejectionCode = toAppendRejectionCode(code);
    const rejection = {
        status: 'rejected',
        update: command.update,
        code: rejectionCode,
        reason: appendRejectionReason(rejectionCode),
        ...(document ? { document } : {})
    } as const;
    return isAppendRejectionRetryable(rejectionCode)
        ? { ...rejection, code: rejectionCode, retryable: true }
        : { ...rejection, code: rejectionCode, retryable: false };
}
