import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import type { CrdtLifecycleMutationResult } from '../crdt-mutation-contracts.ts';
import type { DecodedCrdtMutationResultEnvelope } from '../decode-crdt-mutation-result.ts';
import { decodeExactDocumentMetadata } from '../decoding/decode-exact-document-metadata.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';

export interface DecodeCrdtLifecycleMutationResultInput {
    readonly fields: JsonWireObject;
    readonly envelope: DecodedCrdtMutationResultEnvelope;
}

export function decodeCrdtLifecycleMutationResult(
    input: DecodeCrdtLifecycleMutationResultInput
): CrdtLifecycleMutationResult {
    const { fields, envelope } = input;
    if (envelope.status === 'rejected') {
        if (fields.metadata !== null) {
            throw new TypeError('CRDT lifecycle rejected result metadata is inconsistent');
        }
        return { ...envelope, operation: 'lifecycle', metadata: null };
    }
    if (envelope.status !== 'accepted') {
        throw new TypeError('CRDT lifecycle result status is invalid');
    }
    const metadata = decodeExactDocumentMetadata(
        requireCrdtJsonWireObject(fields.metadata, 'CRDT lifecycle result metadata')
    );
    if (
        metadata.documentKey !== envelope.documentKey ||
        metadata.documentRevision !== envelope.documentRevision ||
        metadata.lastAppendSequence !== envelope.appendSequence
    ) {
        throw new TypeError('CRDT lifecycle result document, revision, or sequence differs');
    }
    return { ...envelope, operation: 'lifecycle', metadata };
}
