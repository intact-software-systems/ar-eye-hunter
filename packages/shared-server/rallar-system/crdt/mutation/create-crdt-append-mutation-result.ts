import {
    type RallarCrdtAppendResult,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtTrustedAppendMetadata
} from '@shared/crdt/mod.ts';

import type { CrdtAppendCommand, CrdtAppendMutationResult } from './crdt-mutation-contracts.ts';

export interface CreateAcceptedCrdtAppendMutationResultInput {
    readonly command: CrdtAppendCommand;
    readonly document: RallarCrdtDocumentMetadata;
    readonly append: RallarCrdtTrustedAppendMetadata;
    readonly appendResult: Extract<RallarCrdtAppendResult, { status: 'accepted'; }>;
}

export interface CreateReplayCrdtAppendMutationResultInput {
    readonly command: CrdtAppendCommand;
    readonly document: RallarCrdtDocumentMetadata;
    readonly append: RallarCrdtTrustedAppendMetadata;
    readonly appendResult: Extract<RallarCrdtAppendResult, { status: 'duplicate'; }>;
}

export interface CreateRejectedCrdtAppendMutationResultInput {
    readonly command: CrdtAppendCommand;
    readonly document: RallarCrdtDocumentMetadata | null;
    readonly code: string;
    readonly appendResult: Extract<RallarCrdtAppendResult, { status: 'rejected'; }>;
}

export function createAcceptedCrdtAppendMutationResult(
    input: CreateAcceptedCrdtAppendMutationResultInput
): CrdtAppendMutationResult {
    return {
        version: 1,
        operation: 'append',
        status: 'accepted',
        commandId: input.command.commandId,
        documentKey: input.command.documentKey,
        documentRevision: input.document.documentRevision,
        appendSequence: input.append.appendSequence,
        code: null,
        appendResult: input.appendResult
    };
}

export function createReplayCrdtAppendMutationResult(
    input: CreateReplayCrdtAppendMutationResultInput
): CrdtAppendMutationResult {
    return {
        version: 1,
        operation: 'append',
        status: 'replay',
        commandId: input.command.commandId,
        documentKey: input.command.documentKey,
        documentRevision: input.document.documentRevision,
        appendSequence: input.append.appendSequence,
        code: null,
        appendResult: input.appendResult
    };
}

export function createRejectedCrdtAppendMutationResult(
    input: CreateRejectedCrdtAppendMutationResultInput
): CrdtAppendMutationResult {
    return {
        version: 1,
        operation: 'append',
        status: 'rejected',
        commandId: input.command.commandId,
        documentKey: input.command.documentKey,
        documentRevision: input.document?.documentRevision ?? null,
        appendSequence: null,
        code: input.code,
        appendResult: input.appendResult
    };
}
