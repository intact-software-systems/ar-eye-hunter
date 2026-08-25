import {
    toRallarCrdtDocumentKey,
    type RallarCrdtDocumentMetadata
} from '@shared/crdt/mod.ts';

import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import {
    requireEpoch,
    requireExactKeys,
    requireNullableEpoch,
    requireOneOf,
    requirePositiveInteger,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import { decodeExactDocumentRef } from './decode-exact-document-ref.ts';
import { decodeExactProjectionIds } from './decode-exact-projection-ids.ts';
import { decodeExactQuotaPolicy } from './decode-exact-quota-policy.ts';
import { decodeExactRetentionPolicy } from './decode-exact-retention-policy.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactDocumentMetadata(value: JsonWireValue): RallarCrdtDocumentMetadata {
    const metadata = requireCrdtJsonWireObject(value, 'CRDT document metadata');
    requireExactKeys(
        metadata,
        [
            'document',
            'documentKey',
            'documentRevision',
            'lifecycle',
            'createdAtEpochMs',
            'updatedAtEpochMs',
            'archivedAtEpochMs',
            'destroyedAtEpochMs',
            'lastAppendSequence',
            'updateCount',
            'snapshotCount',
            'storedUpdateBytes',
            'retention',
            'quota',
            'projectionIds'
        ],
        'CRDT document metadata'
    );
    const document = decodeExactDocumentRef(metadata.document, 'CRDT metadata document');
    requireString(metadata.documentKey, 'metadata documentKey');
    if (toRallarCrdtDocumentKey(document) !== metadata.documentKey) {
        throw new TypeError('CRDT metadata document key differs from document');
    }
    requirePositiveInteger(metadata.documentRevision, 'metadata documentRevision');
    const lifecycle = requireOneOf(
        metadata.lifecycle,
        ['active', 'archived', 'destroyed', 'quarantined'] as const,
        'metadata lifecycle'
    );
    requireEpoch(metadata.createdAtEpochMs, 'metadata createdAtEpochMs');
    requireEpoch(metadata.updatedAtEpochMs, 'metadata updatedAtEpochMs');
    if ((metadata.updatedAtEpochMs as number) < (metadata.createdAtEpochMs as number)) {
        throw new TypeError('CRDT metadata update time precedes creation');
    }
    requireNullableEpoch(metadata.archivedAtEpochMs, 'metadata archivedAtEpochMs');
    requireNullableEpoch(metadata.destroyedAtEpochMs, 'metadata destroyedAtEpochMs');
    if (lifecycle === 'archived' && metadata.archivedAtEpochMs === null) {
        throw new TypeError('CRDT metadata archived lifecycle lacks timestamp');
    }
    if (lifecycle === 'destroyed' && metadata.destroyedAtEpochMs === null) {
        throw new TypeError('CRDT metadata destroyed lifecycle lacks timestamp');
    }
    for (const field of ['lastAppendSequence', 'updateCount', 'snapshotCount', 'storedUpdateBytes']) {
        requireEpoch(metadata[field], `metadata ${field}`);
    }
    if ((metadata.lastAppendSequence as number) < (metadata.updateCount as number)) {
        throw new TypeError('CRDT metadata update counters are inconsistent');
    }
    if (metadata.retention !== null) {
        decodeExactRetentionPolicy(metadata.retention);
    }
    if (metadata.quota !== null) {
        decodeExactQuotaPolicy(metadata.quota);
    }
    decodeExactProjectionIds(metadata.projectionIds);
    return metadata as RallarCrdtDocumentMetadata;
}
