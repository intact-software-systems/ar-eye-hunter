import { validateRallarCrdtSnapshotEnvelope, type RallarCrdtSnapshotEnvelope } from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactOptionalKeys,
    requirePositiveInteger,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeExactDocumentRef } from './decode-exact-document-ref.ts';
import { decodeExactEncryptedEnvelopeShape } from './decode-exact-operation-shapes.ts';
import {
    decodeExactCrdtStateSnapshot,
    decodeExactSequenceState,
    decodeExactSnapshotClock
} from './decode-exact-snapshot-state.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeExactSnapshotEnvelope(value: JsonWireValue): RallarCrdtSnapshotEnvelope {
    const snapshot = requireCrdtJsonWireObject(value, 'CRDT snapshot envelope');
    requireExactOptionalKeys({
        value: snapshot,
        required: [
            'protocolVersion',
            'document',
            'snapshotId',
            'schemaVersion',
            'createdAtEpochMs',
            'maxLamport',
            'includedUpdateIds',
            'value',
            'metadata'
        ],
        optional: ['updateClock', 'hash'],
        label: 'CRDT snapshot envelope'
    });
    decodeExactDocumentRef(snapshot.document, 'CRDT snapshot document');
    if ('updateClock' in snapshot) {
        decodeExactSnapshotClock(snapshot.updateClock);
    }
    if (
        isJsonWireObject(snapshot.value) &&
        snapshot.value.kind === 'encrypted-json'
    ) {
        decodeExactEncryptedEnvelopeShape(snapshot.value);
    }
    requireString(snapshot.snapshotId, 'snapshotId');
    requirePositiveInteger(snapshot.schemaVersion, 'snapshot schemaVersion');
    requireEpoch(snapshot.createdAtEpochMs, 'snapshot createdAtEpochMs');
    requireEpoch(snapshot.maxLamport, 'snapshot maxLamport');
    if (
        !Array.isArray(snapshot.includedUpdateIds) ||
        snapshot.includedUpdateIds.some((id) => typeof id !== 'string' || id.length === 0) ||
        new Set(snapshot.includedUpdateIds).size !== snapshot.includedUpdateIds.length
    ) {
        throw new TypeError('CRDT snapshot included update IDs are invalid');
    }
    const metadata = requireCrdtJsonWireObject(snapshot.metadata, 'CRDT snapshot metadata');
    requireExactOptionalKeys({
        value: metadata,
        required: ['updateCount'],
        optional: [
            'createdByReplicaId',
            'tombstoneCount',
            'conflictCount',
            'reason',
            'crdtState',
            'sequenceState'
        ],
        label: 'CRDT snapshot metadata'
    });
    for (const field of ['updateCount', 'tombstoneCount', 'conflictCount']) {
        if (field in metadata) {
            requireEpoch(metadata[field], `snapshot metadata ${field}`);
        }
    }
    if ('createdByReplicaId' in metadata) {
        requireString(metadata.createdByReplicaId, 'snapshot metadata createdByReplicaId');
    }
    if ('reason' in metadata) {
        requireString(metadata.reason, 'snapshot metadata reason');
    }
    if ('crdtState' in metadata) {
        decodeExactCrdtStateSnapshot(metadata.crdtState);
    }
    if ('sequenceState' in metadata) {
        decodeExactSequenceState(metadata.sequenceState);
    }
    if ('hash' in snapshot) {
        requireString(snapshot.hash, 'snapshot hash');
    }
    if (!validateRallarCrdtSnapshotEnvelope(snapshot).valid) {
        throw new TypeError('CRDT snapshot envelope is invalid');
    }
    return snapshot as RallarCrdtSnapshotEnvelope;
}

function isJsonWireObject(value: JsonWireValue | undefined): value is JsonWireObject {
    return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}
