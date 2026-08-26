import type { RallarCrdtAuditSink } from '@shared/crdt/mod.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import { CRDT_AUDIT_APP_OUTBOX_TYPE } from '../mutation/create-crdt-mutation-outbox.ts';
import { decodeCrdtAuditEvent } from '../mutation/decoding/decode-crdt-audit-event.ts';

export interface RegisterCrdtAuditDeliveryInput {
    readonly outboxQueueReader: OutboxQueueReader;
    readonly auditSink: RallarCrdtAuditSink;
}

export function registerCrdtAuditDelivery(input: RegisterCrdtAuditDeliveryInput): void {
    input.outboxQueueReader.onOutboxMessageDo(CRDT_AUDIT_APP_OUTBOX_TYPE, {
        onMessage: async (message) => {
            if (message.payload.contentType !== 'application/json') {
                throw new TypeError('CRDT audit outbox content type is invalid');
            }
            await input.auditSink.record(decodeCrdtAuditEvent(JSON.parse(message.payload.resource)));
        }
    });
}
