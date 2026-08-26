import type { RallarCrdtAuditEvent } from '@shared/crdt/mod.ts';

import {
    requireEpoch,
    requireExactKeys,
    requireOneOf,
    requireString
} from '../../../protocol/exact-object-decoding.ts';
import type { JsonWireObject, JsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { requireCrdtJsonWireObject } from './require-crdt-json-wire-object.ts';

export function decodeCrdtAuditEvent(value: JsonWireValue): RallarCrdtAuditEvent {
    const event = requireCrdtJsonWireObject(value, 'CRDT audit outbox event');
    try {
        requireExactKeys(
            event,
            ['kind', 'atEpochMs', 'documentKey', 'principalId', 'reason', 'metadata'],
            'CRDT audit outbox event'
        );
        const kind = requireOneOf(
            event.kind,
            ['erase', 'redact'] as const,
            'CRDT audit outbox event kind'
        );
        requireEpoch(event.atEpochMs, 'CRDT audit outbox event epoch');
        requireString(event.documentKey, 'CRDT audit outbox event documentKey');
        requireString(event.principalId, 'CRDT audit outbox event principalId');
        requireString(event.reason, 'CRDT audit outbox event reason');
        return {
            kind,
            atEpochMs: event.atEpochMs as number,
            documentKey: event.documentKey,
            principalId: event.principalId,
            reason: event.reason,
            metadata: decodeCrdtAuditEventMetadata(event.metadata)
        };
    }
    catch {
        throw new TypeError('CRDT audit outbox event is invalid');
    }
}

function decodeCrdtAuditEventMetadata(
    value: JsonWireValue | undefined
): Readonly<Record<string, string | number | boolean>> {
    const metadata = requireCrdtJsonWireObject(value, 'CRDT audit outbox event metadata');
    if (
        Object.values(metadata).some(
            (metadataValue) =>
                typeof metadataValue !== 'string' &&
                typeof metadataValue !== 'number' &&
                typeof metadataValue !== 'boolean'
        )
    ) {
        throw new TypeError('CRDT audit outbox event metadata is invalid');
    }
    return metadata as JsonWireObject & Readonly<Record<string, string | number | boolean>>;
}
