import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';

import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import type { CrdtEraseMutationResult } from '../crdt-mutation-contracts.ts';
import type { DecodedCrdtMutationResultEnvelope } from '../decode-crdt-mutation-result.ts';
import { decodeExactDebugBundle } from '../decode-exact-debug-bundle.ts';
import { decodeExactDocumentMetadata } from '../decoding/decode-exact-document-metadata.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';
import { decodeExactErasureAuditEvent } from './decode-exact-erasure-audit-event.ts';
import { decodeExactErasureRequest } from './decode-exact-erasure-request.ts';

export interface DecodeCrdtEraseMutationResultInput {
    readonly fields: JsonWireObject;
    readonly envelope: DecodedCrdtMutationResultEnvelope;
}

export function decodeCrdtEraseMutationResult(
    input: DecodeCrdtEraseMutationResultInput
): CrdtEraseMutationResult {
    const { fields, envelope } = input;
    if (envelope.status === 'rejected') {
        if (
            fields.request !== null ||
            fields.auditEvent !== null ||
            fields.metadata !== null ||
            fields.redactedBundle !== null
        ) {
            throw new TypeError('CRDT erase rejected result payload is inconsistent');
        }
        return {
            ...envelope,
            operation: 'erase',
            request: null,
            auditEvent: null,
            metadata: null,
            redactedBundle: null
        };
    }
    if (envelope.status !== 'accepted') {
        throw new TypeError('CRDT erase result status is invalid');
    }
    const request = decodeExactErasureRequest(
        requireCrdtJsonWireObject(fields.request, 'CRDT erasure request')
    );
    const auditEvent = decodeExactErasureAuditEvent(
        requireCrdtJsonWireObject(fields.auditEvent, 'CRDT erasure audit event')
    );
    const metadata = decodeExactDocumentMetadata(
        requireCrdtJsonWireObject(fields.metadata, 'CRDT erase result metadata')
    );
    const redactedBundle = fields.redactedBundle === null
        ? null
        : decodeExactDebugBundle(
            requireCrdtJsonWireObject(fields.redactedBundle, 'CRDT erase result bundle')
        );
    if (
        toRallarCrdtDocumentKey(request.document) !== envelope.documentKey ||
        auditEvent.documentKey !== envelope.documentKey ||
        auditEvent.atEpochMs !== request.requestedAtEpochMs ||
        auditEvent.principalId !== request.requestedBy ||
        auditEvent.reason !== request.reason ||
        auditEvent.metadata?.mode !== request.mode ||
        auditEvent.kind !== (request.mode === 'redact-payloads' ? 'redact' : 'erase') ||
        metadata.documentKey !== envelope.documentKey ||
        metadata.documentRevision !== envelope.documentRevision ||
        metadata.lastAppendSequence !== envelope.appendSequence ||
        (redactedBundle !== null && redactedBundle.documentKey !== envelope.documentKey) ||
        (redactedBundle !== null) !== (request.mode === 'redact-payloads')
    ) {
        throw new TypeError('CRDT erase result document or revision differs');
    }
    return {
        ...envelope,
        operation: 'erase',
        request,
        auditEvent,
        metadata,
        redactedBundle
    };
}
