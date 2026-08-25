import { validateRallarCrdtUpdateEnvelope, type RallarCrdtUpdateEnvelope } from '@shared/crdt/mod.ts';

import { requireExactKeys } from '../../protocol/exact-object-decoding.ts';
import { decodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { decodeExactDocumentRef } from './decoding/decode-exact-document-ref.ts';
import {
    decodeExactCausalFrontierShape,
    decodeExactOperationBatchShape
} from './decoding/decode-exact-operation-shapes.ts';
import { requireCrdtJsonWireObject } from './decoding/require-crdt-json-wire-object.ts';

export function decodeExactUpdateEnvelope(value: unknown): RallarCrdtUpdateEnvelope {
    const update = requireCrdtJsonWireObject(
        decodeJsonWireValue(value, 'CRDT update envelope'),
        'CRDT update envelope'
    );
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
