import type { RallarCrdtAuditEvent } from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from '../decoding/require-crdt-json-wire-object.ts';

export function decodeExactErasureAuditEvent(value: JsonWireValue): RallarCrdtAuditEvent {
    const event = requireCrdtJsonWireObject(value, 'CRDT erasure audit event');
    requireExactKeys(
        event,
        ['kind', 'atEpochMs', 'documentKey', 'principalId', 'reason', 'metadata'],
        'CRDT erasure audit event'
    );
    const kind = requireOneOf(event.kind, ['erase', 'redact'] as const, 'erasure audit kind');
    requireEpoch(event.atEpochMs, 'erasure audit atEpochMs');
    requireString(event.documentKey, 'erasure audit documentKey');
    requireString(event.principalId, 'erasure audit principalId');
    requireString(event.reason, 'erasure audit reason');
    const metadata = requireCrdtJsonWireObject(event.metadata, 'CRDT erasure audit metadata');
    requireExactKeys(metadata, ['mode'], 'CRDT erasure audit metadata');
    const mode = requireOneOf(
        metadata.mode,
        ['destroy-document', 'redact-payloads'] as const,
        'audit mode'
    );
    return {
        kind,
        atEpochMs: Number(event.atEpochMs),
        documentKey: event.documentKey,
        principalId: event.principalId,
        reason: event.reason,
        metadata: { mode }
    };
}
