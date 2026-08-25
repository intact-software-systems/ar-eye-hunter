import type { RallarCrdtErasureRequest } from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeExactDocumentRef } from '../decoding/decode-exact-document-ref.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';

export function decodeExactErasureRequest(value: JsonWireValue): RallarCrdtErasureRequest {
    const request = requireCrdtJsonWireObject(value, 'CRDT erasure request');
    requireExactKeys(
        request,
        ['document', 'requestedAtEpochMs', 'requestedBy', 'reason', 'mode'],
        'CRDT erasure request'
    );
    const document = decodeExactDocumentRef(
        requireCrdtJsonWireObject(request.document, 'CRDT erasure document'),
        'CRDT erasure document'
    );
    requireEpoch(request.requestedAtEpochMs, 'erasure requestedAtEpochMs');
    requireString(request.requestedBy, 'erasure requestedBy');
    requireString(request.reason, 'erasure reason');
    const mode = requireOneOf(
        request.mode,
        ['destroy-document', 'redact-payloads'] as const,
        'erasure mode'
    );
    return {
        document,
        requestedAtEpochMs: Number(request.requestedAtEpochMs),
        requestedBy: request.requestedBy,
        reason: request.reason,
        mode
    };
}
