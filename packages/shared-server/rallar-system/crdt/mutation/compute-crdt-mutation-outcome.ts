import type {
    RallarCrdtAppendRejected,
    RallarCrdtAppendResult,
    RallarCrdtDocumentMetadata,
    RallarCrdtTrustedAppendMetadata
} from '@shared/crdt/mod.ts';

import { appendRejectionReason, isAppendRejectionRetryable, toAppendRejectionCode } from './crdt-append-rejection.ts';
import type {
    CrdtAppendCommand,
    CrdtCanonicalSnapshotEnvelope,
    CrdtMutationCommand,
    CrdtMutationComputed,
    CrdtMutationComputedRejected,
    CrdtMutationComputedReplay,
    CrdtMutationComputedWrite,
    CrdtMutationRead
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
    readonly outboxEntries: CrdtMutationComputed['outboxEntries'];
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
    readonly outboxEntries: CrdtMutationComputed['outboxEntries'];
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
        outcome: 'write'
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
        outcome: 'write'
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
        outboxEntries,
        result
    };
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
