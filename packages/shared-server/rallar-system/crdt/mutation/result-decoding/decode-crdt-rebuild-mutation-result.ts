import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import type { CrdtRebuildMutationResult } from '../crdt-mutation-contracts.ts';
import type { DecodedCrdtMutationResultEnvelope } from '../decode-crdt-mutation-result.ts';
import { decodeExactDocumentMetadata } from '../decoding/decode-exact-document-metadata.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';
import { decodeExactIntegrityReport } from './decode-exact-integrity-report.ts';

export interface DecodeCrdtRebuildMutationResultInput {
    readonly fields: JsonWireObject;
    readonly envelope: DecodedCrdtMutationResultEnvelope;
}

export function decodeCrdtRebuildMutationResult(
    input: DecodeCrdtRebuildMutationResultInput
): CrdtRebuildMutationResult {
    const { fields, envelope } = input;
    if (envelope.status === 'rejected') {
        if (fields.integrity !== null || fields.metadata !== null) {
            throw new TypeError('CRDT rebuild rejected result payload is inconsistent');
        }
        return {
            ...envelope,
            operation: 'rebuild-projection',
            integrity: null,
            metadata: null
        };
    }
    if (envelope.status !== 'accepted') {
        throw new TypeError('CRDT rebuild result status is invalid');
    }
    const integrity = decodeExactIntegrityReport(
        requireCrdtJsonWireObject(fields.integrity, 'CRDT rebuild result integrity')
    );
    const metadata = decodeExactDocumentMetadata(
        requireCrdtJsonWireObject(fields.metadata, 'CRDT rebuild result metadata')
    );
    if (
        integrity.documentKey !== envelope.documentKey ||
        metadata.documentKey !== envelope.documentKey ||
        metadata.documentRevision !== envelope.documentRevision ||
        metadata.lastAppendSequence !== envelope.appendSequence
    ) {
        throw new TypeError('CRDT rebuild result document, revision, or sequence differs');
    }
    return {
        ...envelope,
        operation: 'rebuild-projection',
        integrity,
        metadata
    };
}
