import { toRallarCrdtDocumentKey } from '@shared/crdt/mod.ts';

import type { JsonWireObject } from '../../../protocol/json-wire-identity.ts';
import type { CrdtCompactMutationResult } from '../crdt-mutation-contracts.ts';
import type { DecodedCrdtMutationResultEnvelope } from '../decode-crdt-mutation-result.ts';
import { decodeExactDocumentMetadata } from '../decoding/decode-exact-document-metadata.ts';
import { decodeExactSnapshotEnvelope } from '../decoding/decode-exact-snapshot-envelope.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';
import { requireCrdtCanonicalSnapshotReason, toCrdtCanonicalSnapshotEnvelope } from '../to-crdt-canonical-snapshot.ts';

export interface DecodeCrdtCompactMutationResultInput {
    readonly fields: JsonWireObject;
    readonly envelope: DecodedCrdtMutationResultEnvelope;
}

export function decodeCrdtCompactMutationResult(
    input: DecodeCrdtCompactMutationResultInput
): CrdtCompactMutationResult {
    const { fields, envelope } = input;
    if (envelope.status === 'rejected') {
        if (fields.snapshot !== null || fields.metadata !== null) {
            throw new TypeError('CRDT compact rejected result payload is inconsistent');
        }
        return {
            ...envelope,
            operation: 'compact',
            snapshot: null,
            metadata: null
        };
    }
    if (envelope.status !== 'accepted') {
        throw new TypeError('CRDT compact result status is invalid');
    }
    const decodedSnapshot = decodeExactSnapshotEnvelope(
        requireCrdtJsonWireObject(fields.snapshot, 'CRDT compact result snapshot')
    );
    const snapshotReason = decodedSnapshot.metadata.reason;
    requireCrdtCanonicalSnapshotReason(snapshotReason);
    const snapshot = toCrdtCanonicalSnapshotEnvelope(decodedSnapshot, snapshotReason);
    const metadata = decodeExactDocumentMetadata(
        requireCrdtJsonWireObject(fields.metadata, 'CRDT compact result metadata')
    );
    if (
        toRallarCrdtDocumentKey(snapshot.document) !== envelope.documentKey ||
        metadata.documentKey !== envelope.documentKey ||
        metadata.documentRevision !== envelope.documentRevision ||
        metadata.lastAppendSequence !== envelope.appendSequence
    ) {
        throw new TypeError('CRDT compact result document, revision, or sequence differs');
    }
    return {
        ...envelope,
        operation: 'compact',
        snapshot,
        metadata
    };
}
