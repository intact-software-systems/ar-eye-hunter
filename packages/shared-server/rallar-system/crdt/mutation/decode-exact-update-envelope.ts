import { validateRallarCrdtUpdateEnvelope, type RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

import { requireExactKeys, requireRecord } from '../../services/exact-object-codec.ts';
import { decodeExactDocumentRef } from './crdt-mutation-value-codec.ts';
import { decodeExactCausalFrontierShape, decodeExactOperationBatchShape } from './crdt-operation-exact-codec.ts';

export function decodeExactUpdateEnvelope(value: unknown): RallarCrdtUpdateEnvelope {
    const update = requireRecord(value, 'CRDT update envelope');
    const allowed = [
        'protocolVersion',
        'document',
        'updateId',
        'replicaId',
        'lamport',
        'parents',
        'schemaVersion',
        'operationVersion',
        'createdAtEpochMs',
        'payload',
        ...('actorId' in update ? ['actorId'] : []),
        ...('sessionId' in update ? ['sessionId'] : []),
        ...('causalFrontier' in update ? ['causalFrontier'] : []),
        ...('hash' in update ? ['hash'] : [])
    ];
    requireExactKeys(update, allowed, 'CRDT update envelope');
    decodeExactDocumentRef(update.document, 'CRDT update document');
    decodeExactOperationBatchShape(update.payload);
    if ('causalFrontier' in update) {
        decodeExactCausalFrontierShape(update.causalFrontier);
    }
    const validation = validateRallarCrdtUpdateEnvelope(update);
    if (!validation.valid) {
        throw new TypeError('CRDT update envelope is invalid');
    }
    return update as RallarCrdtUpdateEnvelope;
}
