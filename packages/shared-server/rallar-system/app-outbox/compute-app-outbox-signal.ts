import { Temporal } from '@js-temporal/polyfill';
import { AL_MESSAGE_ENVELOPE_VERSION } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import { computeAppOutboxInsert, type AppOutboxInsert } from './app-outbox-insert.ts';

export interface AppOutboxSignalInput {
    readonly topicId: string;
    readonly typeId: string;
    readonly contextId: string;
    readonly resourceId: string;
    readonly resource: string;
    readonly createdAtEpochMs: number;
    readonly dueAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly serviceId: string;
    readonly traceId: string;
}

/** Domain owners supply identity and deadlines; this boundary encodes one exclusive durable delivery. */
export function computeAppOutboxSignal(input: AppOutboxSignalInput): AppOutboxInsert {
    const route = toAppQueueKey({ topicId: input.topicId, contextId: input.contextId, resourceId: input.resourceId });
    const message = decodePersistedALMessageValue({
        id: {
            v: AL_MESSAGE_ENVELOPE_VERSION,
            msgId: route.resourceId,
            ts: input.createdAtEpochMs,
            senderId: input.serviceId,
            traceId: input.traceId
        },
        route,
        constraints: { expiresAtMs: input.expiresAtEpochMs },
        delivery: { ownership: 'exclusive', reliability: 'at-least-once', ack: 'none' },
        payload: { typeId: input.typeId, contentType: 'application/json', resource: input.resource },
        audit: { createdBy: input.serviceId, createdTs: input.createdAtEpochMs }
    });
    return computeAppOutboxInsert({
        ...QueueBoxUtilities.toResourceEntryFromMsg(
            message,
            EnqueuedType.APP_OUTBOX,
            Temporal.Instant.fromEpochMilliseconds(input.createdAtEpochMs)
        ),
        dequeueAudit: { attempts: 0, nextTs: Temporal.Instant.fromEpochMilliseconds(input.dueAtEpochMs) }
    });
}
