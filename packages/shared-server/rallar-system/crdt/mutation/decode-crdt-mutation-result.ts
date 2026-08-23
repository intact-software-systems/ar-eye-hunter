import {
    hashRallarCrdtUpdateEnvelope,
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata,
    type RallarCrdtDocumentRef,
    type RallarCrdtSnapshotEnvelope,
    type RallarCrdtTrustedAppendMetadata,
    type RallarCrdtUpdateEnvelope
} from '@shared/crdt/mod.ts';

import {
    requireExactKeys,
    requireNullableInteger,
    requireOneOf,
    requireRecord,
    requireString
} from '../../protocol/exact-object-decoding.ts';
import { appendRejectionReason, isAppendRejectionRetryable, toAppendRejectionCode } from './crdt-append-rejection.ts';
import type { CrdtMutationResult } from './crdt-mutation-contracts.ts';
import {
    decodeExactErasureAuditEvent,
    decodeExactErasureRequest,
    decodeExactIntegrityReport,
    decodeExactValidationResult
} from './crdt-mutation-result-detail-codec.ts';
import {
    decodeExactDocumentMetadata,
    decodeExactSnapshotEnvelope,
    decodeExactTrustedAppendMetadata
} from './crdt-mutation-value-codec.ts';
import { decodeExactDebugBundle } from './decode-exact-debug-bundle.ts';
import { decodeExactUpdateEnvelope } from './decode-exact-update-envelope.ts';
import { requireCrdtCanonicalSnapshotReason } from './to-crdt-canonical-snapshot.ts';

export function decodeCrdtMutationResult(value: unknown): CrdtMutationResult {
    const result = requireRecord(value, 'CRDT mutation result');
    const operation = requireOneOf(
        result.operation,
        ['append', 'rebuild-projection', 'compact', 'lifecycle', 'erase'] as const,
        'result operation'
    );
    const operationKeys = operation === 'append'
        ? ['appendResult']
        : operation === 'compact'
        ? ['snapshot', 'metadata']
        : operation === 'lifecycle'
        ? ['metadata']
        : operation === 'rebuild-projection'
        ? ['integrity', 'metadata']
        : ['request', 'auditEvent', 'metadata', 'redactedBundle'];
    requireExactKeys(
        result,
        [
            'version',
            'operation',
            'status',
            'commandId',
            'documentKey',
            'documentRevision',
            'appendSequence',
            'code',
            ...operationKeys
        ],
        'CRDT mutation result'
    );
    if (result.version !== 1) {
        throw new TypeError('CRDT mutation result version is invalid');
    }
    const status = requireOneOf(
        result.status,
        ['accepted', 'replay', 'rejected'] as const,
        'result status'
    );
    if (status === 'replay' && operation !== 'append') {
        throw new TypeError('CRDT mutation replay status is valid only for append');
    }
    requireString(result.commandId, 'result commandId');
    requireString(result.documentKey, 'result documentKey');
    requireNullableInteger(result.documentRevision, 'result documentRevision');
    requireNullableInteger(result.appendSequence, 'result appendSequence');
    if (result.code !== null) {
        requireString(result.code, 'result code');
    }
    if (status === 'rejected') {
        if (result.appendSequence !== null || result.code === null) {
            throw new TypeError('CRDT rejected result sequence or code is inconsistent');
        }
    }
    else if (
        result.documentRevision === null ||
        result.appendSequence === null ||
        result.code !== null
    ) {
        throw new TypeError('CRDT accepted result revision, sequence, or code is inconsistent');
    }
    if (operation === 'append') {
        decodeAppendResult(result.appendResult);
    }
    else if (operation === 'compact') {
        if (result.snapshot !== null) {
            const snapshot = decodeExactSnapshotEnvelope(result.snapshot);
            requireCrdtCanonicalSnapshotReason(snapshot.metadata.reason);
        }
        if (result.metadata !== null) {
            decodeExactDocumentMetadata(result.metadata);
        }
    }
    else if (operation === 'lifecycle' && result.metadata !== null) {
        decodeExactDocumentMetadata(result.metadata);
    }
    else if (operation === 'rebuild-projection') {
        if (result.integrity !== null) {
            decodeExactIntegrityReport(requireRecord(result.integrity, 'CRDT integrity report'));
        }
        if (result.metadata !== null) {
            decodeExactDocumentMetadata(result.metadata);
        }
    }
    else if (operation === 'erase') {
        if (result.request !== null) {
            decodeExactErasureRequest(requireRecord(result.request, 'CRDT erasure request'));
        }
        if (result.auditEvent !== null) {
            decodeExactErasureAuditEvent(requireRecord(result.auditEvent, 'CRDT erasure audit event'));
        }
        if (result.metadata !== null) {
            decodeExactDocumentMetadata(result.metadata);
        }
        if (result.redactedBundle !== null) {
            decodeExactDebugBundle(result.redactedBundle);
        }
    }
    validateResultConsistency(result, operation);
    return result as CrdtMutationResult & Record<string, unknown>;
}

function validateResultConsistency(
    result: Record<string, unknown>,
    operation: CrdtMutationResult['operation']
): void {
    const rejected = result.status === 'rejected';
    if (rejected !== (result.code !== null) || (rejected && result.appendSequence !== null)) {
        throw new TypeError('CRDT mutation result status and code are inconsistent');
    }
    if (operation === 'append') {
        const append = result.appendResult as Record<string, unknown>;
        const expected = result.status === 'accepted'
            ? 'accepted'
            : result.status === 'replay'
            ? 'duplicate'
            : 'rejected';
        if (append.status !== expected) {
            throw new TypeError('CRDT append result status is inconsistent');
        }
        if (!rejected) {
            const update = append.update as RallarCrdtUpdateEnvelope;
            const trusted = append.append as RallarCrdtTrustedAppendMetadata;
            const document = append.document as RallarCrdtDocumentMetadata;
            if (
                result.documentKey !== document.documentKey ||
                result.documentKey !== toRallarCrdtDocumentKey(update.document) ||
                result.documentRevision !== document.documentRevision ||
                result.appendSequence !== trusted.appendSequence ||
                document.lastAppendSequence < trusted.appendSequence ||
                trusted.acceptedUpdateHash !== hashRallarCrdtUpdateEnvelope(update)
            ) {
                throw new TypeError('CRDT append result document, revision, or sequence differs');
            }
        }
        else {
            const update = append.update as RallarCrdtUpdateEnvelope;
            const document = append.document as RallarCrdtDocumentMetadata | undefined;
            if (
                toRallarCrdtDocumentKey(update.document) !== result.documentKey ||
                (result.documentRevision === null) !== (document === undefined) ||
                (document &&
                    (document.documentKey !== result.documentKey ||
                        document.documentRevision !== result.documentRevision))
            ) {
                throw new TypeError('CRDT append rejection document or revision differs');
            }
        }
        return;
    }
    if (operation === 'compact' || operation === 'lifecycle' || operation === 'rebuild-projection') {
        const metadata = result.metadata as RallarCrdtDocumentMetadata | null;
        const operationPayload = operation === 'compact'
            ? result.snapshot
            : operation === 'rebuild-projection'
            ? result.integrity
            : metadata;
        if (rejected !== (metadata === null) || rejected !== (operationPayload === null)) {
            throw new TypeError(`CRDT ${operation} result status and payload are inconsistent`);
        }
        if (
            !rejected &&
            (metadata!.documentKey !== result.documentKey ||
                metadata!.documentRevision !== result.documentRevision ||
                metadata!.lastAppendSequence !== result.appendSequence)
        ) {
            throw new TypeError(`CRDT ${operation} result metadata revision or sequence differs`);
        }
    }
    if (!rejected && operation === 'lifecycle') {
        const metadata = result.metadata as RallarCrdtDocumentMetadata;
        if (
            metadata.documentKey !== result.documentKey ||
            metadata.documentRevision !== result.documentRevision ||
            metadata.lastAppendSequence !== result.appendSequence
        ) {
            throw new TypeError('CRDT lifecycle result document, revision, or sequence differs');
        }
    }
    if (!rejected && operation === 'compact') {
        const snapshot = result.snapshot as RallarCrdtSnapshotEnvelope;
        if (toRallarCrdtDocumentKey(snapshot.document) !== result.documentKey) {
            throw new TypeError('CRDT compact result document differs');
        }
    }
    if (!rejected && operation === 'rebuild-projection') {
        const integrity = result.integrity as Record<string, unknown>;
        if (integrity.documentKey !== result.documentKey) {
            throw new TypeError('CRDT rebuild result document differs');
        }
    }
    if (!rejected && operation === 'erase') {
        if (result.request === null || result.auditEvent === null || result.metadata === null) {
            throw new TypeError('CRDT erase accepted result payload is inconsistent');
        }
        const request = result.request as Record<string, unknown>;
        const auditEvent = result.auditEvent as Record<string, unknown>;
        const metadata = result.metadata as RallarCrdtDocumentMetadata;
        const bundle = result.redactedBundle as Record<string, unknown> | null;
        const auditMetadata = auditEvent.metadata as Record<string, unknown>;
        const mode = request.mode;
        if (
            toRallarCrdtDocumentKey(request.document as RallarCrdtDocumentRef) !== result.documentKey ||
            auditEvent.documentKey !== result.documentKey ||
            auditEvent.atEpochMs !== request.requestedAtEpochMs ||
            auditEvent.principalId !== request.requestedBy ||
            auditEvent.reason !== request.reason ||
            auditMetadata.mode !== mode ||
            auditEvent.kind !== (mode === 'redact-payloads' ? 'redact' : 'erase') ||
            metadata.documentKey !== result.documentKey ||
            metadata.documentRevision !== result.documentRevision ||
            metadata.lastAppendSequence !== result.appendSequence ||
            (bundle !== null && bundle.documentKey !== result.documentKey) ||
            (bundle !== null) !== (mode === 'redact-payloads')
        ) {
            throw new TypeError('CRDT erase result document or revision differs');
        }
    }
    else if (rejected && operation === 'erase') {
        if (
            result.request !== null ||
            result.auditEvent !== null ||
            result.metadata !== null ||
            result.redactedBundle !== null
        ) {
            throw new TypeError('CRDT erase rejected result payload is inconsistent');
        }
    }
}

function decodeAppendResult(value: unknown): void {
    const append = requireRecord(value, 'CRDT append result');
    const status = requireOneOf(
        append.status,
        ['accepted', 'duplicate', 'rejected'] as const,
        'append status'
    );
    if (status === 'accepted' || status === 'duplicate') {
        requireExactKeys(append, ['status', 'update', 'append', 'document'], 'CRDT append result');
        decodeExactUpdateEnvelope(append.update);
        decodeExactTrustedAppendMetadata(append.append);
        decodeExactDocumentMetadata(append.document);
        return;
    }
    const keys = [
        'status',
        'update',
        'code',
        'reason',
        'retryable',
        ...('validation' in append ? ['validation'] : []),
        ...('document' in append ? ['document'] : [])
    ];
    requireExactKeys(append, keys, 'CRDT append rejection');
    requireString(append.code, 'append rejection code');
    requireString(append.reason, 'append rejection reason');
    const code = append.code;
    const reason = append.reason;
    const supportedCode = toAppendRejectionCode(code);
    if (supportedCode !== code) {
        throw new TypeError('CRDT append rejection code is invalid');
    }
    if (appendRejectionReason(supportedCode) !== reason) {
        throw new TypeError('CRDT append rejection reason differs from code');
    }
    if (typeof append.retryable !== 'boolean') {
        throw new TypeError('append retryable is invalid');
    }
    if (append.retryable !== isAppendRejectionRetryable(supportedCode)) {
        throw new TypeError('CRDT append rejection retryable differs from code');
    }
    decodeExactUpdateEnvelope(append.update);
    if ('validation' in append) {
        decodeExactValidationResult(requireRecord(append.validation, 'CRDT validation result'));
    }
    if ('document' in append) {
        decodeExactDocumentMetadata(append.document);
    }
}
