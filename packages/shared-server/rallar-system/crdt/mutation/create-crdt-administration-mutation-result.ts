import {
    createRallarCrdtDebugBundle,
    createRallarCrdtErasureAuditEvent,
    verifyRallarCrdtDebugBundle,
    type RallarCrdtDocumentMetadata
} from '@shared/crdt/mod.ts';

import type {
    CrdtAppendCommand,
    CrdtCanonicalSnapshotEnvelope,
    CrdtMutationCommand,
    CrdtMutationRead,
    CrdtMutationResult
} from './crdt-mutation-contracts.ts';

export interface CreateAcceptedCrdtAdministrationMutationResultInput {
    readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
    readonly read: CrdtMutationRead;
    readonly document: RallarCrdtDocumentMetadata;
    readonly snapshot: CrdtCanonicalSnapshotEnvelope | null;
}

export interface CreateRejectedCrdtAdministrationMutationResultInput {
    readonly command: Exclude<CrdtMutationCommand, CrdtAppendCommand>;
    readonly document: RallarCrdtDocumentMetadata | null;
    readonly code: string;
}

export function createAcceptedCrdtAdministrationMutationResult(
    input: CreateAcceptedCrdtAdministrationMutationResultInput
): CrdtMutationResult {
    const { command, read, document, snapshot } = input;
    const common = {
        version: 1 as const,
        status: 'accepted' as const,
        commandId: command.commandId,
        documentKey: command.documentKey,
        documentRevision: document.documentRevision,
        appendSequence: document.lastAppendSequence,
        code: null
    };
    switch (command.operation) {
        case 'compact':
            if (!snapshot) {
                throw new TypeError('Accepted CRDT compaction requires a snapshot');
            }
            return { ...common, operation: command.operation, snapshot, metadata: document };
        case 'lifecycle':
            return { ...common, operation: command.operation, metadata: document };
        case 'rebuild-projection': {
            const bundle = createAdministrationDebugBundle(command, read, document);
            return {
                ...common,
                operation: command.operation,
                integrity: verifyRallarCrdtDebugBundle(bundle),
                metadata: document
            };
        }
        case 'erase': {
            const bundle = createAdministrationDebugBundle(command, read, document);
            const request = {
                document: command.document,
                requestedAtEpochMs: command.capturedAtEpochMs,
                requestedBy: command.actor.principalId,
                reason: command.reason,
                mode: command.mode
            } as const;
            return {
                ...common,
                operation: command.operation,
                request,
                auditEvent: createRallarCrdtErasureAuditEvent(request),
                metadata: document,
                redactedBundle: command.mode === 'redact-payloads' ? bundle : null
            };
        }
    }
}

export function createRejectedCrdtAdministrationMutationResult(
    input: CreateRejectedCrdtAdministrationMutationResultInput
): CrdtMutationResult {
    const { command, document, code } = input;
    const common = {
        version: 1 as const,
        status: 'rejected' as const,
        commandId: command.commandId,
        documentKey: command.documentKey,
        documentRevision: document?.documentRevision ?? null,
        appendSequence: null,
        code
    };
    switch (command.operation) {
        case 'compact':
            return {
                ...common,
                operation: command.operation,
                snapshot: null,
                metadata: null
            };
        case 'lifecycle':
            return { ...common, operation: command.operation, metadata: null };
        case 'rebuild-projection':
            return {
                ...common,
                operation: command.operation,
                integrity: null,
                metadata: null
            };
        case 'erase':
            return {
                ...common,
                operation: command.operation,
                request: null,
                auditEvent: null,
                metadata: null,
                redactedBundle: null
            };
    }
}

function createAdministrationDebugBundle(
    command: Extract<CrdtMutationCommand, { operation: 'rebuild-projection' | 'erase'; }>,
    read: CrdtMutationRead,
    document: RallarCrdtDocumentMetadata
) {
    return createRallarCrdtDebugBundle({
        exportedAtEpochMs: command.capturedAtEpochMs,
        reason: command.operation === 'erase' ? command.reason : `rebuild:${command.projectionId}`,
        document: command.document,
        metadata: document,
        ...(read.snapshot ? { snapshot: read.snapshot } : {}),
        records: read.records,
        ...(command.operation === 'erase' && command.mode === 'redact-payloads'
            ? { redaction: { payloadsRedacted: true, reason: command.reason } }
            : {})
    });
}
